import test from 'node:test';
import { nativeCelFixture } from './native-cel-fixture.mjs';
import { exerciseNativeLearnedComposition } from './learned-composition-native-fixture.mjs';
import { exerciseCompleteFeedbackRounds } from './learned-composition-feedback-rounds.mjs';
import { prepareCompleteModelRecovery } from './learned-composition-recovery.mjs';

test('actual complete-model two new feedback rounds recover a clean model and newly authorized belief after native training and online source withdrawal',async t=>{
  const cel=await nativeCelFixture(t);
  await exerciseNativeLearnedComposition(t,{fullFit:true,fullAdmission:true,qualifiedReads:true,versionedCompute:true,
    historyVersion:'plus-native-action-interval-policy-v3',sourceGovernanceCel:cel.client,
    afterAdmission:async c=>{
      const recovery=await prepareCompleteModelRecovery(c,cel);
      const result=await exerciseCompleteFeedbackRounds(c,{withdrawCurrent:recovery.withdrawCurrent});
      await recovery.recover(result.restored);return result;
    }});
});
