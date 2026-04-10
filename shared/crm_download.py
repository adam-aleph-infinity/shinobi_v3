"""
Download call recordings for a given agent/customer pair from any CRM.

Recordings are stored in S3. CRM→bucket mapping:
    mlbcrm.io  → mlb-bucket-prod
    brtcrm.io  → brt-production
    sfxcrm.io  → sfx-bucket-prod

AWS credentials are read from .env (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY).

Usage:
    python -m shared.crm_download --crm https://mlbcrm.io --agent "Dan Brooks" --customer "Chris Odendaal"
    python -m shared.crm_download --crm https://mlbcrm.io --agent "Ron Silver-re10" --customer "Petros Georgiou"
    python -m shared.crm_download --crm https://mlbcrm.io --agent "Dan Brooks" --customer "Chris Odendaal" --min-duration 60
    python -m shared.crm_download --crm https://mlbcrm.io --agent "Dan Brooks" --customer "Chris Odendaal" --output data/my_folder/
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from shared.crm_client import (
    load_credentials,
    list_agent_customer_pairs,
    get_calls_for_pair,
)

LOCAL_FALLBACK = Path(__file__).parent.parent / "data" / "callRecords"

# CRM host → S3 bucket
S3_BUCKETS = {
    "mlbcrm.io":  "mlb-bucket-prod",
    "brtcrm.io":  "brt-production",
    "sfxcrm.io":  "sfx-bucket-prod",
}

ENV_FILE = Path(__file__).parent.parent / ".env"

def load_aws_env():
    """Load AWS credentials from .env into environment."""
    if not ENV_FILE.exists():
        return
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if "=" in line and not line.startswith("#"):
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip())

def s3_download(bucket: str, s3_prefix: str, dest_dir: Path) -> tuple[int, int]:
    """
    Sync s3://{bucket}/{s3_prefix} to dest_dir.
    Returns (downloaded, failed).
    """
    load_aws_env()
    dest_dir.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        ["aws", "s3", "sync", f"s3://{bucket}/{s3_prefix}", str(dest_dir), "--no-progress"],
        capture_output=False,
    )
    if result.returncode != 0:
        return 0, 1
    count = len(list(dest_dir.glob("*.wav")))
    return count, 0


def slugify(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")


def default_output_dir(crm_url: str, agent: str, customer: str) -> Path:
    host = crm_url.replace("https://", "").replace("http://", "").split(".")[0]
    return (
        Path(__file__).parent.parent
        / "data"
        / f"{host}_{slugify(agent)}_{slugify(customer)}"
        / "audio"
    )


def main():
    parser = argparse.ArgumentParser(description="Download CRM call recordings")
    parser.add_argument("--crm",          required=True,  help="CRM base URL, e.g. https://mlbcrm.io")
    parser.add_argument("--agent",        required=True,  help="Agent full name")
    parser.add_argument("--customer",     required=True,  help="Customer name (partial match)")
    parser.add_argument("--output",       default=None,   help="Output directory for .wav files")
    parser.add_argument("--date-start",   default="01/01/2024 00:00")
    parser.add_argument("--date-end",     default="01/04/2026 00:00")
    parser.add_argument("--min-duration", type=int, default=0,
                        help="Skip calls shorter than N seconds")
    parser.add_argument("--manifest",     default=None,
                        help="Write manifest JSON to this path (default: output/../manifest.json)")
    parser.add_argument("--dry-run",      action="store_true",
                        help="List files without downloading")
    args = parser.parse_args()

    creds = load_credentials()

    # ── Find matching pairs ────────────────────────────────────────────────────
    print(f"Searching {args.crm} for agent='{args.agent}' customer='{args.customer}' ...")
    pairs = list_agent_customer_pairs(
        args.crm, creds,
        agent_filter=args.agent,
        customer_filter=args.customer,
        date_start=args.date_start,
        date_end=args.date_end,
    )

    if not pairs:
        print("No matching agent/customer pairs found.")
        sys.exit(1)

    if len(pairs) > 1:
        print(f"Found {len(pairs)} matching pairs:")
        for i, p in enumerate(pairs):
            print(f"  [{i}] {p['agent']} / {p['customer']} (account_id:{p['account_id']}, {p['total_calls']} calls)")
        idx = int(input("Select index: "))
        pair = pairs[idx]
    else:
        pair = pairs[0]

    print(f"\nAgent    : {pair['agent']} (id:{pair['agent_id']})")
    print(f"Customer : {pair['customer']} (account_id:{pair['account_id']})")
    print(f"FTD      : {pair['ftd_at']}")
    print(f"Calls    : {pair['total_calls']} total, {pair['recorded_calls']} recorded")

    # ── Fetch full call list ──────────────────────────────────────────────────
    calls = get_calls_for_pair(
        args.crm, creds,
        agent_name=args.agent,
        account_id=pair["account_id"],
        date_start=args.date_start,
        date_end=args.date_end,
    )

    # ── Output directory ──────────────────────────────────────────────────────
    audio_dir = (
        Path(args.output)
        if args.output
        else default_output_dir(args.crm, pair["agent"], pair["customer"])
    )
    manifest_path = (
        Path(args.manifest)
        if args.manifest
        else audio_dir.parent / "manifest.json"
    )

    if not args.dry_run:
        audio_dir.mkdir(parents=True, exist_ok=True)

    # ── Process calls ─────────────────────────────────────────────────────────
    print(f"\nProcessing {len(calls)} calls → {audio_dir}\n")
    downloaded = copied = skipped = failed = no_rec = 0

    if args.dry_run:
        for c in calls:
            if c["record_path"]:
                print(f"  [{c['call_id']}] {c['duration_s']}s  {c['started_at']}  {c['record_path']}")
        print(f"\nDry run — {len(calls)} calls total")
        return

    # Mark skipped/no-rec before S3 sync
    for c in calls:
        if not c["record_path"]:
            c["status"] = "no_recording"
            no_rec += 1
        elif (c["duration_s"] or 0) < args.min_duration:
            c["status"] = f"skipped_{c['duration_s']}s"
            skipped += 1

    # ── S3 download (primary) ─────────────────────────────────────────────────
    from urllib.parse import urlparse
    host = urlparse(args.crm).netloc
    bucket = S3_BUCKETS.get(host)
    if bucket:
        s3_prefix = f"callRecords/accounts/{pair['account_id']}/"
        print(f"Downloading from s3://{bucket}/{s3_prefix} ...")
        load_aws_env()
        result = subprocess.run(
            ["aws", "s3", "sync", f"s3://{bucket}/{s3_prefix}", str(audio_dir), "--no-progress"],
        )
        if result.returncode == 0:
            for c in calls:
                if not c["record_path"] or c.get("status"):
                    continue
                dest = audio_dir / f"{c['call_id']}.wav"
                if dest.exists():
                    c["status"] = "downloaded"
                    c["local_file"] = str(dest)
                    downloaded += 1
                else:
                    c["status"] = "missing"
                    failed += 1
        else:
            print("  S3 sync failed — falling back to local copy")
            bucket = None

    # ── Local fallback copy ───────────────────────────────────────────────────
    if not bucket:
        for c in calls:
            if not c["record_path"] or c.get("status"):
                continue
            fname     = f"{c['call_id']}.wav"
            dest      = audio_dir / fname
            local_src = LOCAL_FALLBACK / fname
            if dest.exists():
                c["status"] = "exists"
                skipped += 1
            elif local_src.exists():
                shutil.copy2(local_src, dest)
                c["status"] = "copied_local"
                c["local_file"] = str(dest)
                copied += 1
            else:
                c["status"] = "missing"
                failed += 1

    if args.dry_run:
        print(f"\nDry run — {len(calls)} calls total")
        return

    # ── Write manifest ────────────────────────────────────────────────────────
    manifest = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "crm":          args.crm,
        "agent":        pair["agent"],
        "agent_id":     pair["agent_id"],
        "customer":     pair["customer"],
        "account_id":   pair["account_id"],
        "ftd_at":       pair["ftd_at"],
        "date_range":   {"start": args.date_start, "end": args.date_end},
        "summary": {
            "total_calls":    len(calls),
            "copied_local":   copied,
            "downloaded":     downloaded,
            "already_exists": skipped,
            "missing":        failed,
            "no_recording":   no_rec,
        },
        "calls": sorted(calls, key=lambda x: x["started_at"]),
    }
    manifest_path.write_text(json.dumps(manifest, indent=2))

    print(f"\nDone.")
    print(f"  Copied from local : {copied}")
    print(f"  Downloaded        : {downloaded}")
    print(f"  Already existed   : {skipped}")
    print(f"  Missing           : {failed}")
    print(f"  No recording      : {no_rec}")
    print(f"  Audio dir         : {audio_dir}")
    print(f"  Manifest          : {manifest_path}")


if __name__ == "__main__":
    main()
