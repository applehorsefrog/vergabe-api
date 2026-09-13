#!/usr/bin/env python3
"""ETL: Datenservice Öffentlicher Einkauf (eForms-DE XML) -> normalised rows -> SQL for Cloudflare D1.

Source: https://oeffentlichevergabe.de/api/notice-exports?pubDay=YYYY-MM-DD&format=eforms.zip
Licence of source data: CC0 (https://oeffentlichevergabe.de/ui/de/Open-Data-Richtlinie)

Personal data policy: every cac:Contact block (names, e-mail, phone, fax) is dropped.
Only organisation-level data (name, address, website) is kept.

Usage:
  python etl.py --day 2026-09-10 --out out/2026-09-10.sql
  python etl.py --zip local.zip --day 2026-09-10 --out out.sql --json out.json
"""
from __future__ import annotations

import argparse
import io
import json
import re
import sys
import urllib.request
import zipfile
from pathlib import Path

from lxml import etree

NS = {
    "cbc": "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
    "cac": "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
    "ext": "urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2",
    "efac": "http://data.europa.eu/p27/eforms-ubl-extension-aggregate-components/1",
    "efbc": "http://data.europa.eu/p27/eforms-ubl-extension-basic-components/1",
    "efext": "http://data.europa.eu/p27/eforms-ubl-extensions/1",
}

EXPORT_URL = "https://oeffentlichevergabe.de/api/notice-exports?pubDay={day}&format=eforms.zip"
NOTICE_URL = "https://oeffentlichevergabe.de/api/notices/{nid}?format=eforms-de&noticeVersion={ver}"

# eForms notice-type codes -> coarse kind
KIND = {
    "pin-only": "planning", "pin-buyer": "planning", "pin-rtl": "planning", "pin-cfc-standard": "planning",
    "pin-cfc-social": "planning", "pin-tran": "planning", "qu-sy": "planning",
    "cn-standard": "competition", "cn-social": "competition", "cn-desg": "competition", "subco": "competition",
    "can-standard": "result", "can-social": "result", "can-desg": "result", "can-tran": "result",
    "can-modif": "result", "veat": "result", "corr": "change", "brin-eeig": "other", "brin-ecs": "other",
}


def txt(el, path):
    r = el.xpath(path, namespaces=NS)
    if not r:
        return None
    v = r[0]
    if isinstance(v, etree._Element):
        v = v.text
    return (v or "").strip() or None


def txts(el, path):
    out = []
    for v in el.xpath(path, namespaces=NS):
        if isinstance(v, etree._Element):
            v = v.text
        v = (v or "").strip()
        if v:
            out.append(v)
    return out


EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
PHONE_RE = re.compile(r"(?<![\d.])(?:\+\d{1,3}[\s/-]?\(?\d{1,5}\)?|\(?0\d{2,5}\)?)[\s/-]?\d{2,4}(?:[\s/-]?\d{2,4}){1,3}(?!\d)")
CONTACT_LINE_RE = re.compile(r"(?i)(ansprechpartner(?:in)?|kontakt(?:person)?|contact)\s*[:\-]\s*[^\n;*]{0,80}")
INLINE_CONTACT_RE = re.compile(r"(?i)[,;]?\s*\b(?:tel(?:efon)?\b\.?|fax\b|e-?mail\b)\s*:?\s*[^,;\n]{3,60}")


def scrub(s):
    """Remove personal contact data from free text (GDPR: no contact persons, e-mails, phone numbers)."""
    if not s:
        return s
    s = EMAIL_RE.sub("[e-mail entfernt]", s)
    s = INLINE_CONTACT_RE.sub("", s)
    s = CONTACT_LINE_RE.sub(lambda m: m.group(1) + ": [entfernt]", s)
    s = PHONE_RE.sub(lambda m: "[tel. entfernt]" if len(re.sub(r"\D", "", m.group(0))) >= 7 else m.group(0), s)
    return s


def cpv(code):
    """Normalise CPV: strip check digit suffix (72000000-5 -> 72000000)."""
    if not code:
        return None
    return code.split("-")[0].strip() or None


def clean_date(s):
    if not s:
        return None
    return s[:10]


def clean_time(s):
    if not s:
        return None
    m = re.match(r"(\d{2}:\d{2})", s)
    return m.group(1) if m else None


def parse_notice(xml_bytes: bytes, pub_day: str) -> dict | None:
    try:
        root = etree.fromstring(xml_bytes)
    except etree.XMLSyntaxError:
        return None
    nid = txt(root, "./cbc:ID[@schemeName='notice-id']") or txt(root, "./cbc:ID")
    if not nid:
        return None
    version = txt(root, "./cbc:VersionID") or "01"
    notice_type = txt(root, "./cbc:NoticeTypeCode")
    kind = KIND.get(notice_type or "", "other")
    subtype = txt(root, ".//efac:NoticeSubType/cbc:SubTypeCode")
    changed = txt(root, ".//efac:Changes/efbc:ChangedNoticeIdentifier")
    if changed and kind == "competition":
        kind = "change"

    # organisations (contact blocks intentionally ignored)
    orgs = {}
    for org in root.xpath(".//efac:Organizations/efac:Organization/efac:Company", namespaces=NS):
        oid = txt(org, "./cac:PartyIdentification/cbc:ID")
        if not oid:
            continue
        orgs[oid] = {
            "name": scrub(txt(org, "./cac:PartyName/cbc:Name")),
            "city": txt(org, "./cac:PostalAddress/cbc:CityName"),
            "postal": txt(org, "./cac:PostalAddress/cbc:PostalZone"),
            "nuts": txt(org, "./cac:PostalAddress/cbc:CountrySubentityCode"),
            "country": txt(org, "./cac:PostalAddress/cac:Country/cbc:IdentificationCode"),
            "website": txt(org, "./cbc:WebsiteURI"),
        }
    buyer_ref = txt(root, "./cac:ContractingParty/cac:Party/cac:PartyIdentification/cbc:ID")
    buyer = orgs.get(buyer_ref or "", {}) or (next(iter(orgs.values())) if orgs else {})
    if not buyer.get("name"):
        # older eForms-DE variant: party data inline, no Organizations block
        p = root.find("./cac:ContractingParty/cac:Party", NS)
        if p is not None:
            buyer = {
                "name": scrub(txt(p, "./cac:PartyName/cbc:Name")),
                "city": txt(p, "./cac:PostalAddress/cbc:CityName"),
                "postal": txt(p, "./cac:PostalAddress/cbc:PostalZone"),
                "nuts": txt(p, "./cac:PostalAddress/cbc:CountrySubentityCode"),
                "country": txt(p, "./cac:PostalAddress/cac:Country/cbc:IdentificationCode"),
                "website": txt(p, "./cbc:WebsiteURI"),
            }

    proj = root.find("./cac:ProcurementProject", NS)
    title = txt(proj, "./cbc:Name") if proj is not None else None
    desc = txt(proj, "./cbc:Description") if proj is not None else None
    nature = txt(proj, "./cbc:ProcurementTypeCode") if proj is not None else None
    cpv_main = cpv(txt(proj, "./cac:MainCommodityClassification/cbc:ItemClassificationCode")) if proj is not None else None
    cpv_add = [cpv(x) for x in txts(proj, "./cac:AdditionalCommodityClassification/cbc:ItemClassificationCode")] if proj is not None else []
    cpv_add = [x for x in cpv_add if x and x != cpv_main]
    place_nuts = txt(proj, "./cac:RealizedLocation/cac:Address/cbc:CountrySubentityCode") if proj is not None else None
    place_city = txt(proj, "./cac:RealizedLocation/cac:Address/cbc:CityName") if proj is not None else None
    est_value = txt(proj, "./cac:RequestedTenderTotal/cbc:EstimatedOverallContractAmount") if proj is not None else None
    currency = None
    if proj is not None:
        r = proj.xpath("./cac:RequestedTenderTotal/cbc:EstimatedOverallContractAmount/@currencyID", namespaces=NS)
        currency = r[0] if r else None

    procedure = txt(root, "./cac:TenderingProcess/cbc:ProcedureCode")
    legal_basis = txt(root, "./cac:TenderingTerms/cac:ProcurementLegislationDocumentReference/cbc:ID")
    buyer_type = txt(root, "./cac:ContractingParty/cac:ContractingPartyType/cbc:PartyTypeCode")
    regulatory = txt(root, "./cbc:RegulatoryDomain")
    issue_date = clean_date(txt(root, "./cbc:IssueDate"))

    lots = []
    deadlines = []
    doc_urls = []
    submit_urls = []
    for lot in root.xpath("./cac:ProcurementProjectLot", namespaces=NS):
        lid = txt(lot, "./cbc:ID")
        lp = lot.find("./cac:ProcurementProject", NS)
        ltitle = txt(lp, "./cbc:Name") if lp is not None else None
        lcpv = cpv(txt(lp, "./cac:MainCommodityClassification/cbc:ItemClassificationCode")) if lp is not None else None
        lnuts = txt(lp, "./cac:RealizedLocation/cac:Address/cbc:CountrySubentityCode") if lp is not None else None
        lval = txt(lp, "./cac:RequestedTenderTotal/cbc:EstimatedOverallContractAmount") if lp is not None else None
        d = clean_date(txt(lot, "./cac:TenderingProcess/cac:TenderSubmissionDeadlinePeriod/cbc:EndDate"))
        t = clean_time(txt(lot, "./cac:TenderingProcess/cac:TenderSubmissionDeadlinePeriod/cbc:EndTime"))
        dkind = "tender"
        if not d:
            d = clean_date(txt(lot, "./cac:TenderingProcess/cac:ParticipationRequestReceptionPeriod/cbc:EndDate"))
            t = clean_time(txt(lot, "./cac:TenderingProcess/cac:ParticipationRequestReceptionPeriod/cbc:EndTime"))
            dkind = "participation" if d else None
        start = clean_date(txt(lp, "./cac:PlannedPeriod/cbc:StartDate")) if lp is not None else None
        end = clean_date(txt(lp, "./cac:PlannedPeriod/cbc:EndDate")) if lp is not None else None
        dur = txt(lp, "./cac:PlannedPeriod/cbc:DurationMeasure") if lp is not None else None
        if d:
            deadlines.append((d, t or "23:59", dkind))
        doc_urls += txts(lot, "./cac:TenderingTerms/cac:CallForTendersDocumentReference/cac:Attachment/cac:ExternalReference/cbc:URI")
        submit_urls += txts(lot, "./cac:TenderingTerms/cac:TenderRecipientParty/cbc:EndpointID")
        if lid and lid.upper().startswith("LOT"):
            lots.append({
                "id": lid, "title": scrub(ltitle), "cpv": lcpv, "nuts": lnuts,
                "estimated_value": float(lval) if lval else None,
                "deadline_date": d, "deadline_time": t, "deadline_kind": dkind,
                "period_start": start, "period_end": end, "duration": dur,
            })
    if not doc_urls:
        doc_urls = txts(root, ".//cac:CallForTendersDocumentReference/cac:Attachment/cac:ExternalReference/cbc:URI")
    if not submit_urls:
        submit_urls = txts(root, ".//cac:TenderRecipientParty/cbc:EndpointID")
    deadline_date, deadline_time, deadline_kind = (sorted(deadlines)[0] if deadlines else (None, None, None))

    # award results: winners are organisations (company names), not persons
    winners = []
    total_awarded = None
    for lt in root.xpath(".//efac:NoticeResult/efac:LotTender", namespaces=NS):
        amt = txt(lt, "./cac:LegalMonetaryTotal/cbc:PayableAmount")
        if amt:
            winners.append({"amount": float(amt)})
    ta = txt(root, ".//efac:NoticeResult/cbc:TotalAmount")
    if ta:
        total_awarded = float(ta)
    winner_names = []
    for w in root.xpath(".//efac:NoticeResult/efac:TenderingParty/efac:Tenderer/cbc:ID", namespaces=NS):
        o = orgs.get((w.text or "").strip())
        if o and o.get("name"):
            winner_names.append(o["name"])

    rec = {
        "id": f"{nid}-{version}",
        "notice_id": nid,
        "version": version,
        "published": pub_day,
        "issue_date": issue_date,
        "kind": kind,
        "notice_type": notice_type,
        "subtype": subtype,
        "changed_notice": changed,
        "procedure": procedure,
        "legal_basis": legal_basis,
        "regulatory_domain": regulatory,
        "nature": nature,
        "title": scrub(title),
        "description": scrub((desc or "")[:4000]) or None,
        "cpv_main": cpv_main,
        "cpv_additional": cpv_add,
        "buyer_name": buyer.get("name"),
        "buyer_type": buyer_type,
        "buyer_city": buyer.get("city"),
        "buyer_postal": buyer.get("postal"),
        "buyer_nuts": buyer.get("nuts"),
        "buyer_country": buyer.get("country"),
        "buyer_website": buyer.get("website"),
        "place_nuts": place_nuts or buyer.get("nuts"),
        "place_city": place_city,
        "estimated_value": float(est_value) if est_value else None,
        "currency": currency,
        "deadline_date": deadline_date,
        "deadline_time": deadline_time,
        "deadline_kind": deadline_kind,
        "documents_url": doc_urls[0] if doc_urls else None,
        "submission_url": submit_urls[0] if submit_urls else None,
        "lots": lots,
        "lot_count": len(lots),
        "winners": winner_names[:20],
        "total_awarded": total_awarded,
        "source_url": NOTICE_URL.format(nid=nid, ver=version),
    }
    return rec


def sql_str(v):
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, (list, dict)):
        v = json.dumps(v, ensure_ascii=False)
    return "'" + str(v).replace("'", "''").replace("\x00", "") + "'"


COLUMNS = [
    "id", "notice_id", "version", "published", "issue_date", "kind", "notice_type", "subtype", "changed_notice",
    "procedure", "legal_basis", "regulatory_domain", "nature", "title", "description", "cpv_main", "cpv_additional",
    "buyer_name", "buyer_type", "buyer_city", "buyer_postal", "buyer_nuts", "buyer_country", "buyer_website",
    "place_nuts", "place_city", "estimated_value", "currency", "deadline_date", "deadline_time", "deadline_kind", "documents_url",
    "submission_url", "lots", "lot_count", "winners", "total_awarded", "source_url",
]


def to_sql(recs, pub_day):
    out = []
    for r in recs:
        vals = ", ".join(sql_str(r[c]) for c in COLUMNS)
        out.append(f"INSERT OR REPLACE INTO notices ({', '.join(COLUMNS)}) VALUES ({vals});")
    counts = {}
    for r in recs:
        counts[r["kind"]] = counts.get(r["kind"], 0) + 1
    out.append(
        "INSERT OR REPLACE INTO days (day, notices, competition, result, planning, change, loaded_at) VALUES ("
        f"{sql_str(pub_day)}, {len(recs)}, {counts.get('competition',0)}, {counts.get('result',0)}, "
        f"{counts.get('planning',0)}, {counts.get('change',0)}, datetime('now'));"
    )
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--day", required=True)
    ap.add_argument("--zip", help="local zip instead of download")
    ap.add_argument("--out", required=True, help="SQL output path (chunked: out, out.1, ...)")
    ap.add_argument("--json", help="optional JSON dump of records")
    ap.add_argument("--chunk", type=int, default=150, help="statements per SQL file")
    a = ap.parse_args()

    if a.zip:
        data = Path(a.zip).read_bytes()
    else:
        req = urllib.request.Request(EXPORT_URL.format(day=a.day), headers={"User-Agent": "vergabe-api-etl/0.1 (CC0 open data; contact via GitHub)"})
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = resp.read()
    zf = zipfile.ZipFile(io.BytesIO(data))
    recs = []
    bad = 0
    for name in zf.namelist():
        if not name.endswith(".xml"):
            continue
        rec = parse_notice(zf.read(name), a.day)
        if rec:
            recs.append(rec)
        else:
            bad += 1
    print(f"{a.day}: {len(recs)} notices parsed, {bad} skipped", file=sys.stderr)

    stmts = to_sql(recs, a.day)
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    files = []
    for i in range(0, len(stmts), a.chunk):
        p = out if i == 0 else out.with_suffix(f".{i // a.chunk}.sql")
        p.write_text("\n".join(stmts[i:i + a.chunk]) + "\n", encoding="utf-8")
        files.append(str(p))
    print("\n".join(files))
    if a.json:
        Path(a.json).write_text(json.dumps(recs, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
