#!/usr/bin/env python3
import argparse, json, shutil
from datetime import datetime, timezone
from pathlib import Path

HERE=Path(__file__).resolve().parent
ROOT=HERE.parent
TEMPLATES=ROOT/'assets'/'templates'

def main():
    ap=argparse.ArgumentParser(description='Create an Evidence Envelope workspace')
    ap.add_argument('--finding-id', required=True)
    ap.add_argument('--title', default='')
    ap.add_argument('--output', required=True)
    args=ap.parse_args()
    out=Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=True)
    for d in ['sources','derived','collectors','reproduction','sampling','manifest','reports','review-notes']:
        (out/d).mkdir(exist_ok=True)
    mapping={
      'finding.template.json':'finding.json',
      'claims.template.json':'claims.json',
      'hypotheses.template.json':'hypotheses.json',
      'evidence-index.template.json':'evidence-index.json',
      'completeness.template.json':'completeness.json',
      'decision.template.json':'decision.json'
    }
    for src,dst in mapping.items():
        data=json.loads((TEMPLATES/src).read_text(encoding='utf-8'))
        if dst=='finding.json':
            data['findingId']=args.finding_id
            data['title']=args.title
            data['createdAt']=datetime.now(timezone.utc).isoformat()
        (out/dst).write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(out)
if __name__=='__main__': main()
