#!/usr/bin/env python3
import argparse, json, sys
from pathlib import Path

REQUIRED=['finding.json','claims.json','hypotheses.json','evidence-index.json','completeness.json','decision.json','manifest.json']
TERMINAL={'COMPLETE_ISSUE':'ISSUE','COMPLETE_CLOSE':'CLOSE'}
MANDATORY={'G1','G2','G3','G4','G5','G8','G9','G10'}

def load(path, errors):
    try: return json.loads(path.read_text(encoding='utf-8'))
    except Exception as e:
        errors.append(f'{path.name}: invalid JSON: {e}')
        return {}

def validate(root):
    errors=[]
    for name in REQUIRED:
        if not (root/name).is_file(): errors.append(f'missing {name}')
    if errors: return errors
    finding=load(root/'finding.json',errors)
    claims=load(root/'claims.json',errors)
    hypotheses=load(root/'hypotheses.json',errors)
    evidence=load(root/'evidence-index.json',errors)
    comp=load(root/'completeness.json',errors)
    decision=load(root/'decision.json',errors)
    load(root/'manifest.json',errors)
    if errors: return errors
    evid_ids={e.get('id') for e in evidence.get('evidence',[]) if e.get('id')}
    for c in claims.get('claims',[]):
        if c.get('material') and not c.get('evidenceIds'): errors.append(f"material claim {c.get('id')} has no evidence")
        for eid in c.get('evidenceIds',[]):
            if eid not in evid_ids: errors.append(f"claim {c.get('id')} cites missing {eid}")
    hyp_ids={h.get('id') for h in hypotheses.get('hypotheses',[]) if h.get('id')}
    allowed_h={'SUPPORTED','WEAKENED','EXCLUDED','UNRESOLVED'}
    for h in hypotheses.get('hypotheses',[]):
        if h.get('status') not in allowed_h: errors.append(f"hypothesis {h.get('id')} invalid status")
    state=decision.get('reviewState')
    if state not in {'INCOMPLETE',*TERMINAL}: errors.append(f'invalid reviewState {state}')
    if finding.get('reviewState')!=state or comp.get('reviewState')!=state:
        errors.append('reviewState mismatch across finding/completeness/decision')
    unresolved=set(comp.get('materialUnresolvedHypothesisIds',[]))
    if not unresolved.issubset(hyp_ids): errors.append('completeness cites unknown hypothesis')
    if state=='INCOMPLETE':
        if decision.get('recommendation') not in (None,''): errors.append('incomplete review cannot recommend Issue or Close')
        if not decision.get('nextEvidenceAction'): errors.append('incomplete review needs nextEvidenceAction')
        if not decision.get('stopCondition'): errors.append('incomplete review needs stopCondition')
    elif state in TERMINAL:
        if decision.get('recommendation')!=TERMINAL[state]: errors.append('terminal recommendation mismatch')
        if unresolved: errors.append('terminal review has material unresolved hypotheses')
        gates={g.get('id'):g.get('status') for g in comp.get('gates',[])}
        for gid in MANDATORY:
            if gates.get(gid)!='PASS': errors.append(f'{gid} must PASS for terminal review')
        for h in hypotheses.get('hypotheses',[]):
            if h.get('materialToDecision') and h.get('status')=='UNRESOLVED': errors.append(f"material hypothesis {h.get('id')} unresolved")
        if not decision.get('decisiveEvidenceIds'): errors.append('terminal review needs decisive evidence')
    return errors

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('envelope')
    args=ap.parse_args()
    root=Path(args.envelope).resolve()
    errors=validate(root)
    if errors:
        for e in errors: print('ERROR',e)
        return 1
    print('VALID',root)
    return 0
if __name__=='__main__': sys.exit(main())
