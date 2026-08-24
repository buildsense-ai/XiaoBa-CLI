#!/usr/bin/env python3
import argparse, hashlib, json, platform, sys
from datetime import datetime, timezone
from pathlib import Path

def sha(p):
    h=hashlib.sha256()
    with p.open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''): h.update(chunk)
    return h.hexdigest()

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('envelope')
    args=ap.parse_args()
    root=Path(args.envelope).resolve()
    rows=[]
    for p in sorted(root.rglob('*')):
        if p.is_file() and p.name!='manifest.json':
            rows.append({'path':str(p.relative_to(root)),'bytes':p.stat().st_size,'sha256':sha(p)})
    data={'schemaVersion':'1.0','generatedAt':datetime.now(timezone.utc).isoformat(),'python':sys.version.split()[0],'platform':platform.platform(),'files':rows}
    (root/'manifest.json').write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(root/'manifest.json')
if __name__=='__main__': main()
