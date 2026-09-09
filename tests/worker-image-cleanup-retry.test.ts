import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
const script=fs.readFileSync(new URL('../ops/ctyun-worker-image/New-CatsCoWorkerImage.ps1',import.meta.url),'utf8');
const body=script.slice(script.indexOf('function Remove-Builder {'),script.indexOf('function Remove-KeyPair {'));
for(const mode of ['busy','unsupported-then-busy','forbidden','always-busy'])test(`temporary builder deletion: ${mode}`,()=>{
 const ps=`$ErrorActionPreference='Stop'
$RegionID='test-region';$script:BuilderID='owned-id';$script:BuilderResourceID='owned-resource';$script:BuilderName='owned-name';$script:deleted=$false;$script:calls=@();$script:proofs=0
function Resolve-BuilderInstance {if(-not $script:deleted){return @{instanceID='owned-id'}}}
function Assert-TemporaryBuilder {param($i) if($i.instanceID -ne 'owned-id'){throw 'foreign'};$script:proofs++}
function Get-BoundedDeadline {return (Get-Date).AddMinutes(1)}
function Wait-PollInterval {}
function Write-BakeProgress {}
function Invoke-Ctyun {
 param([string[]]$CliArgs)
 $script:calls+=,@($CliArgs)
 if('${mode}' -eq 'forbidden'){throw 'Ecs.Forbidden'}
 if('${mode}' -eq 'unsupported-then-busy' -and $script:calls.Count -eq 1){throw 'Ecs.Region.NotSupport'}
 if('${mode}' -eq 'always-busy' -or $script:calls.Count -lt 3){throw 'Ecs.Instance.DiskStatusNotValid'}
 $script:deleted=$true
}
${body}
$err='';try{Remove-Builder}catch{$err=$_.Exception.Message}
[ordered]@{count=$script:calls.Count;proofs=$script:proofs;error=$err;deleted=$script:deleted;tokens=@($script:calls|ForEach-Object{$_[([array]::IndexOf($_,'--clientToken')+1)]})}|ConvertTo-Json -Compress
`;
 const result=spawnSync(process.platform==='win32'?'pwsh.exe':'pwsh',['-NoLogo','-NoProfile','-NonInteractive','-Command',ps],{encoding:'utf8',windowsHide:true});
 assert.equal(result.status,0,result.stderr);
 const row=JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)!);
 assert.equal(new Set(row.tokens).size,1);
 assert.equal(row.proofs,row.count+1);
 if(mode==='forbidden'){assert.equal(row.count,1);assert.match(row.error,/Forbidden/);}
 else if(mode==='always-busy'){assert.equal(row.count,9);assert.match(row.error,/DiskStatusNotValid/);}
 else{assert.equal(row.count,3);assert.equal(row.deleted,true);assert.equal(row.error,'');}
});
