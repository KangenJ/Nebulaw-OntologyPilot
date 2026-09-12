import copy
import hashlib
import json
import os
import unittest
from pathlib import Path
import torch
from core import Dynamics, ContractError, WEIGHT_HASH
from learning import fit, check_rows, learning_request, network_for, evaluate, sha


def fixtures():
    rows=[]
    for partition in ('TRAIN','EVAL'):
        keys=[];i=0
        while len(keys)<4:
            key=f'synthetic-{partition}-{i}';i+=1
            if ('EVAL' if int(sha(key)[:8],16)%2==0 else 'TRAIN')==partition:keys.append(key)
        for i,key in enumerate(keys):
            rows.append({'id':partition+str(i),'version':2,'outcomeId':'o'+partition+str(i),'outcomeVersion':2,'caseId':'m'+partition+str(i),'mechanismKey':key,'split':partition,'context':[], 'initialAction':0,
                'schedule':[{'l':1,'f':i%2,'requested_action':1,'probe':0},{'l':1,'f':i%2,'requested_action':1,'probe':1}],
                'actualActions':[i%2,(i//2)%2]})
    return rows


class LearningTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.model=Dynamics(Path(os.environ.get('CHECKPOINT',Path(__file__).resolve().parents[2]/'var/models/p36b-seed61.pt')))

    def test_two_rounds_change_real_weights_and_reproduce(self):
        rows=fixtures();first=fit(self.model.network,'null',rows)
        self.assertGreater(first['evaluation']['parameterL1Change'],0)
        self.assertTrue(first['evaluation']['passed'])
        self.assertEqual(first,fit(self.model.network,'null',rows))
        second=fit(self.model.network,first['artifactJson'],rows)
        self.assertNotEqual(first['artifactHash'],second['artifactHash'])
        self.assertTrue(second['evaluation']['passed'])
        self.assertEqual(second,fit(self.model.network,first['artifactJson'],rows))
        base=dict(self.model.network.named_parameters());candidate=dict(network_for(self.model.network,second['artifactJson']).named_parameters())
        changed=[k for k in base if not torch.equal(base[k],candidate[k])]
        self.assertEqual(changed,['coefficient_readout.4.weight','coefficient_readout.4.bias'])

    def test_evaluation_labels_never_enter_gradient(self):
        rows=fixtures();changed=copy.deepcopy(rows)
        for r in changed:
            if r['split']=='EVAL':r['actualActions']=[1,1]
        a=fit(self.model.network,'null',rows);b=fit(self.model.network,'null',changed)
        self.assertEqual(a['artifactHash'],b['artifactHash'])
        self.assertNotEqual(a['evaluation']['candidate'],b['evaluation']['candidate'])

    def test_degraded_candidate_is_held(self):
        rows=fixtures()
        for r in rows:
            r['actualActions']=[1,1] if r['split']=='TRAIN' else [0,0]
        trained=fit(self.model.network,'null',rows)
        self.assertFalse(trained['evaluation']['passed'])

    def test_model_or_passed_flag_tamper_fails_recomputation(self):
        rows=fixtures();candidate=fit(self.model.network,'null',rows)
        request={'parentArtifactJson':'null','rows':rows,'candidateArtifactJson':candidate['artifactJson'],'evaluationJson':candidate['evaluationJson']}
        self.assertTrue(learning_request(self.model.network,request,review=True)['verified'])
        fake=json.loads(request['evaluationJson']);fake['candidate']['nll']=0;request['evaluationJson']=json.dumps(fake)
        with self.assertRaises(ContractError):learning_request(self.model.network,request,review=True)

    def test_split_and_duplicate_case_rejected(self):
        rows=fixtures();rows[0]['split']='EVAL'
        with self.assertRaises(ContractError):check_rows(rows)
        rows=fixtures();rows[1]['caseId']=rows[0]['caseId']
        with self.assertRaises(ContractError):check_rows(rows)


if __name__=='__main__':unittest.main()
