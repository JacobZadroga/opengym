// The Cloudflare build deliberately omits process-based and background Coach jobs.
export const coachConfig = { publicConfig: () => null, clearProfileAuth() {} };
export const coachJobs = { recoverOnBoot() {}, setProposalHook() {} };
export const coachRoutes = () => ({});
export function startCadence() {}
export function startWarmup() {}
