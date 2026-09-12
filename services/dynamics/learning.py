"""Deterministic, bounded updates to the existing neural output head (260 params).

No experiment imports; no global activation; training and evaluation are separate.
Inputs are immutable, qualified native trajectory snapshots supplied by the API.
"""
import copy
import hashlib
import json
import math
from pathlib import Path
import numpy as np
import torch
from torch import nn
from core import ContractError, WEIGHT_HASH, binary, exact, validate, propagate, observation_kernel

CONFIG = {'schema':'r-head-sgd-v1', 'steps':40, 'learningRate':0.02,
          'parentNllTolerance':0.005, 'parentBrierTolerance':0.005,
          'baseNllTolerance':0.01, 'baseBrierTolerance':0.01,
          'scope':'Existing neural coefficient_readout final layer only; H and E unchanged'}


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def artifact_hash(text):
    return WEIGHT_HASH if text == 'null' else sha(text)


def network_for(base, text):
    if text == 'null':
        return base
    if not isinstance(text, str) or len(text) > 20000:
        raise ContractError('Bounded JSON model artifact required')
    artifact = json.loads(text)
    exact(artifact, ['schema','baseHash','weight','bias'], 'artifact')
    if artifact['schema'] != 'coefficient-head-v1' or artifact['baseHash'] != WEIGHT_HASH:
        raise ContractError('Unsupported artifact or frozen base')
    w, b = np.asarray(artifact['weight']), np.asarray(artifact['bias'])
    if w.shape != (4,64) or b.shape != (4,) or w.dtype.kind not in 'fi' or b.dtype.kind not in 'fi':
        raise ContractError('Invalid neural head tensor shape/type')
    if not np.isfinite(w).all() or not np.isfinite(b).all() or np.abs(w).max() > 8 or np.abs(b).max() > 8:
        raise ContractError('Invalid neural head tensor range')
    model = copy.deepcopy(base).eval()
    with torch.no_grad():
        model.coefficient_readout[-1].weight.copy_(torch.tensor(w,dtype=torch.float32))
        model.coefficient_readout[-1].bias.copy_(torch.tensor(b,dtype=torch.float32))
    return model


def check_rows(rows):
    if not isinstance(rows, list) or not 8 <= len(rows) <= 64:
        raise ContractError('8–64 qualified trajectories required')
    ids, outcomes, cases, groups = set(), set(), set(), {}
    for r in rows:
        exact(r, ['id','version','outcomeId','outcomeVersion','caseId','mechanismKey','split','context','initialAction','schedule','actualActions'], 'trajectory snapshot')
        if not all(isinstance(r[k],str) and 0 < len(r[k]) <= 200 for k in ('id','outcomeId','caseId','mechanismKey')):
            raise ContractError('Bounded native identities required')
        if r['id'] in ids or r['outcomeId'] in outcomes or r['caseId'] in cases:
            raise ContractError('One independent trajectory per native case/outcome')
        ids.add(r['id']); outcomes.add(r['outcomeId']); cases.add(r['caseId'])
        for k in ('version','outcomeVersion'):
            if type(r[k]) is not int or r[k] < 1: raise ContractError('Positive source versions required')
        expected = 'EVAL' if int(sha(r['mechanismKey'])[:8],16) % 2 == 0 else 'TRAIN'
        if r['split'] != expected: raise ContractError('Mechanism-group split mismatch')
        if r['mechanismKey'] in groups and groups[r['mechanismKey']] != r['split']:
            raise ContractError('Mechanism leakage')
        groups[r['mechanismKey']] = r['split']
        if not isinstance(r['actualActions'],list) or len(r['actualActions']) != len(r['schedule']):
            raise ContractError('Full realized trajectory required')
        for x in r['actualActions']: binary(x)
        option={'name':'a','schedule':r['schedule'],'costAct':0,'costRefrain':0,'interventionCost':0}
        validate({'initialAction':r['initialAction'],'behaviorDemonstrations':r['context'],'observationDemonstrations':[],
                  'options':[option,{**option,'name':'b'}]})
    for split in ('TRAIN','EVAL'):
        if len([r for r in rows if r['split']==split]) < 4 or len({r['mechanismKey'] for r in rows if r['split']==split}) < 2:
            raise ContractError('Each partition needs at least four cases from two mechanism groups')


def prepared(network, rows):
    values=[]
    with torch.no_grad():
        for row in rows:
            features=network.coefficient_readout[:-1](network.encode(row['context']))[0].detach()
            previous=row['initialAction']; xs=[]; ys=[]
            for s, actual in zip(row['schedule'],row['actualActions']):
                xs.append([1,2*s['l']-1,2*s['f']-1,2*int(previous==s['requested_action'])-1])
                ys.append(float(actual==s['requested_action'])); previous=actual
            values.append((features,torch.tensor(xs,dtype=torch.float32),torch.tensor(ys)))
    return values


def evaluate(network, rows):
    if not rows: raise ContractError('Evaluation rows required')
    nll=[]; brier=[]
    with torch.inference_mode():
        for row,(features,x,y) in zip(rows,prepared(network,rows)):
            coefficients=network.coefficient_readout[-1](features)
            # Joint path likelihood factorizes on the observed prefix. This is
            # not a gold reset in forecast: final-R Brier uses free propagation.
            nll.append(float(nn.functional.binary_cross_entropy_with_logits(x@coefficients,y)))
            _,rk=network(row['context'])
            hk,_=observation_kernel([])
            _,final_r,_=propagate(rk.numpy().astype(float),hk,row['initialAction'],row['schedule'])
            brier.append(float((final_r[1]-row['actualActions'][-1])**2))
    return {'nll':float(np.mean(nll)), 'brier':float(np.mean(brier)), 'cases':len(rows),
            'groups':len({r['mechanismKey'] for r in rows})}


def fit(base, parent_text, rows):
    check_rows(rows)
    parent=network_for(base,parent_text)
    model=copy.deepcopy(parent).eval()
    for p in model.parameters(): p.requires_grad_(False)
    head=model.coefficient_readout[-1]
    for p in head.parameters(): p.requires_grad_(True)
    samples=prepared(model,[r for r in rows if r['split']=='TRAIN'])
    optimizer=torch.optim.SGD(head.parameters(),lr=CONFIG['learningRate'])
    original=[p.detach().clone() for p in head.parameters()]
    losses=[]
    for _ in range(CONFIG['steps']):
        optimizer.zero_grad(set_to_none=True)
        loss=torch.stack([nn.functional.binary_cross_entropy_with_logits(x@head(f),y) for f,x,y in samples]).mean()
        loss=loss+0.1*sum((p-v).square().mean() for p,v in zip(head.parameters(),original))
        loss.backward(); nn.utils.clip_grad_norm_(head.parameters(),1.0); optimizer.step()
        with torch.no_grad():
            for p in head.parameters(): p.clamp_(-8,8)
        losses.append(float(loss.detach()))
    model.eval()
    artifact=encoded({'schema':'coefficient-head-v1','baseHash':WEIGHT_HASH,
                      'weight':head.weight.detach().tolist(),'bias':head.bias.detach().tolist()})
    eval_rows=[r for r in rows if r['split']=='EVAL']
    candidate,previous,baseline=(evaluate(m,eval_rows) for m in (model,parent,base))
    passed=all(candidate[k] <= previous[k]+CONFIG['parent'+label+'Tolerance'] and candidate[k] <= baseline[k]+CONFIG['base'+label+'Tolerance'] for k,label in [('nll','Nll'),('brier','Brier')])
    delta=sum(float((p.detach()-v).abs().sum()) for p,v in zip(head.parameters(),original))
    evaluation={'schema':'neural-release-evaluation-v1','config':CONFIG,'passed':bool(passed),
        'learnerImplementationHash':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'candidate':candidate,'parent':previous,'baseline':baseline,'trainLossStart':losses[0],'trainLossEnd':losses[-1],
        'parameterL1Change':delta,'updatedParameters':260,'artifactHash':sha(artifact),
        'datasetContentHash':sha(encoded(rows)),'parentArtifactHash':artifact_hash(parent_text),
        'evaluationTrainingOverlap':False,'trainingCases':len(samples),
        'effectivenessScope':'Qualified supplied trajectories; synthetic demo validation is not field-effectiveness evidence'}
    return {'artifactJson':artifact,'evaluationJson':encoded(evaluation),'artifactHash':sha(artifact),
            'evaluation':evaluation,'modelHash':sha(artifact)}


def learning_request(base, data, review=False):
    fields=['parentArtifactJson','rows']+(['candidateArtifactJson','evaluationJson'] if review else [])
    exact(data,fields,'learning request')
    result=fit(base,data['parentArtifactJson'],data['rows'])
    if review:
        if result['artifactJson'] != data['candidateArtifactJson'] or result['evaluationJson'] != data['evaluationJson']:
            raise ContractError('Recomputed training/evaluation differs from stored candidate')
        return {'verified':True,'passed':result['evaluation']['passed'],'artifactHash':result['artifactHash']}
    return result
