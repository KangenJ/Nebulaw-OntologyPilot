import test from 'node:test';
import { exerciseNativeLearnedComposition } from './learned-composition-native-fixture.mjs';
import { exerciseCompleteFeedbackRounds } from './learned-composition-feedback-rounds.mjs';

test('actual Task complete-model first admission and two new complete FIT/whole-evaluation rounds reject regression and requalify a clean model rollback',async t=>{
  await exerciseNativeLearnedComposition(t,{fullFit:true,fullAdmission:true,qualifiedReads:true,versionedCompute:true,
    historyVersion:'plus-native-action-interval-policy-v3',afterAdmission:exerciseCompleteFeedbackRounds});
});
