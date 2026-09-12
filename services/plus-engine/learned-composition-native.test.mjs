import test from 'node:test';
import { exerciseNativeLearnedComposition } from './learned-composition-native-fixture.mjs';

// Existing qualification entry point; preserve its explicit environment choices.
test('actual native Task component decision qualifies the learned combination recipe and current withdrawal invalidates reuse',async t=>{
  await exerciseNativeLearnedComposition(t,{
    fullFit:process.env.PLUS_NATIVE_COMPOSITION_JOB==='1',
    fullAdmission:process.env.PLUS_NATIVE_COMPOSITION_ADMISSION==='1',
    historyVersion:process.env.PLUS_NATIVE_COMPOSITION_HISTORY_V2==='1'?'plus-native-action-interval-policy-v2':'plus-native-action-interval-policy-v1',
  });
});
