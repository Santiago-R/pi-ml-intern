"""Download an explicitly named PRIVATE Trackio SQLite snapshot for local review."""
import argparse
import contextlib
import io
import json
import os
import re
import shutil
import socket
import sqlite3
import tempfile
import time
from pathlib import Path, PurePosixPath
from urllib.parse import quote

from huggingface_hub import HfApi, hf_hub_download

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--repo", required=True, help="Private dataset OWNER/NAME (or hf://datasets/OWNER/NAME)")
parser.add_argument("--file", required=True, help="Exact SQLite file within that dataset, e.g. verify/train-final.sqlite")
parser.add_argument("--project", required=True, help="Trackio project used while logging")
parser.add_argument("--run", help="Optional run name to filter the listed metrics")
parser.add_argument("--dashboard", action="store_true", help="Show the downloaded snapshot on localhost until Ctrl-C")
args = parser.parse_args()
repo = args.repo.removeprefix("hf://datasets/")
if not re.fullmatch(r"[A-Za-z0-9][\w.-]*/[A-Za-z0-9][\w.-]*", repo, re.ASCII):
    parser.error("--repo must explicitly name one dataset: OWNER/NAME")
file = PurePosixPath(args.file)
if file.is_absolute() or any(part in (".", "..") for part in args.file.split("/")) or file.suffix not in (".sqlite", ".db"):
    parser.error("--file must be a relative SQLite path inside the private dataset")
if not re.fullmatch(r"[A-Za-z0-9][\w.-]*", args.project, re.ASCII) or len(args.project) > 80:
    parser.error("--project must be a 1–80 character ASCII Trackio project ID")
token = os.environ.get("HF_TOKEN")
if not token:
    parser.error("HF_TOKEN must be in the environment; do not paste it into the command")
if HfApi(token=token).repo_info(repo, repo_type="dataset").private is not True:
    raise RuntimeError("Selected metrics dataset is not private; refusing to download")

with tempfile.TemporaryDirectory(prefix="private-trackio-review-") as directory:
    root = Path(directory)
    remote = hf_hub_download(repo_id=repo, repo_type="dataset", filename=str(file),
                             token=token, local_dir=root / "download")
    local_dir = root / "trackio"
    local_dir.mkdir()
    database = local_dir / f"{args.project}.db"
    shutil.copyfile(remote, database)
    with sqlite3.connect(database) as connection:
        values = connection.execute("SELECT run_name, step, metrics FROM metrics ORDER BY run_name, step").fetchall()
    rows = [(name, step, json.loads(metrics)) for name, step, metrics in values
            if args.run is None or name == args.run]
    if not rows:
        raise RuntimeError("No metric rows matched the selected snapshot and run")
    print(f"Private Trackio snapshot: {repo}/{file} ({len(rows)} metric rows)")
    for name, step, metrics in rows:
        print(f"  {name} step {step}: {json.dumps(metrics, sort_keys=True)}")
    if args.dashboard:
        os.environ["TRACKIO_DIR"] = str(local_dir)  # set before importing Trackio
        import trackio
        run_names = [run.name for run in trackio.Api().runs(args.project)]
        if args.run and args.run not in run_names:
            raise RuntimeError("Trackio could not load the selected run")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        # Trackio otherwise prints a local write-token URL; never print that token.
        with contextlib.redirect_stdout(io.StringIO()):
            app, url, share_url, _ = trackio.show(
                project=args.project, host="127.0.0.1", share=False,
                mcp_server=False, open_browser=False, block_thread=False, server_port=port)
        try:
            if share_url is not None:
                raise RuntimeError("Trackio unexpectedly enabled sharing")
            print(f"View locally: {url.rstrip('/')}?project={quote(args.project)} (Ctrl-C to close; no public share link)", flush=True)
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
        finally:
            app.close()
