import {verifyFitResourceBoundary} from './fit-resource-boundary.mjs';
try{
  verifyFitResourceBoundary(process.env.PLUS_WORKER_CPU_IDS);
  await import('./worker-once.mjs');
}catch{
  process.stdout.write(JSON.stringify({schema:'plus-worker-error-v1',code:'FIT_ISOLATION_KERNEL_BOUNDARY_MISSING'})+'\n');
  process.exitCode=2;
}
