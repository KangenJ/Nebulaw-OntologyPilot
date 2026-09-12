import copy
import hashlib
import os
import tempfile
import unittest
from pathlib import Path
import numpy as np
from core import Dynamics, ContractError, WEIGHT_HASH, validate, observation_kernel


def sample():
    return {'initialAction':0,'behaviorDemonstrations':[],'observationDemonstrations':[],
        'options':[{'name':str(f),'schedule':[{'requested_action':1,'l':1,'f':f,'probe':0},{'requested_action':1,'l':1,'f':f,'probe':1}], 'costAct':2,'costRefrain':8,'interventionCost':f} for f in (0,1)]}


class InferenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.path=Path(os.environ.get('CHECKPOINT',Path(__file__).resolve().parents[2]/'var/models/p36b-seed61.pt'))
        cls.model=Dynamics(cls.path)

    def test_context_changes_predictions_without_training(self):
        data=sample(); prior=self.model.infer(data)
        data['behaviorDemonstrations']=[{'l':1,'f':1,'prev_action':1,'requested_action':1,'next_action':1} for _ in range(16)]
        learned=self.model.infer(data)
        self.assertNotEqual(prior['coefficients'],learned['coefficients'])
        self.assertNotEqual(prior['options'][0]['actProbability'],learned['options'][0]['actProbability'])
        self.assertEqual(hashlib.sha256(self.path.read_bytes()).hexdigest(),WEIGHT_HASH)
        self.assertEqual(learned,self.model.infer(data))

    def test_distributions_and_e_no_reality_write(self):
        out=self.model.infer(sample())
        for option in out['options']:
            for key in ('finalR','finalH','finalE'):
                self.assertAlmostEqual(sum(option[key].values()),1,places=7)
            self.assertAlmostEqual(sum(option['jointHSequence']),1,places=7)
            self.assertEqual(option['finalH']['MISSING'],option['finalE']['NOT_PROVED'])
        self.assertFalse(out['onticRWrite']); self.assertFalse(out['businessFactsWritten'])

    def test_contract_rejects_oracle_and_unbounded_values(self):
        cases=[]
        d=sample();d['trueKernel']=[1];cases.append(d)
        d=sample();d['initialAction']=True;cases.append(d)
        d=sample();d['options'][0]['costAct']=float('nan');cases.append(d)
        d=sample();d['options'][0]['schedule']*=3;cases.append(d)
        d=sample();d['behaviorDemonstrations']=[{}]*25;cases.append(d)
        d=sample();d['observationDemonstrations']=[{'alignment':0,'probe':0,'outcome':'secret'}];cases.append(d)
        for data in cases:
            with self.assertRaises(ContractError): validate(data)

    def test_observation_update_is_explicit_analytical_prior(self):
        a,pa=observation_kernel([])
        b,pb=observation_kernel([{'alignment':1,'probe':0,'outcome':'MISSING'}]*16)
        self.assertFalse(np.allclose(a,b)); self.assertFalse(np.allclose(pa,pb))
        self.assertAlmostEqual(float(pb.sum()),1)

    def test_tampered_checkpoint_fails_closed(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'bad.pt'; p.write_bytes(b'not-approved')
            with self.assertRaisesRegex(RuntimeError,'hash'): Dynamics(p)


if __name__=='__main__': unittest.main()
