/** A failure with a definite HTTP status and a stable error code for clients. */
export class ApiFailure extends Error {
  constructor(
    /** 502: GitHub refused or failed a write the decision needs (`rerun_checks`, #61). */
    readonly status: 400 | 403 | 404 | 409 | 422 | 502,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiFailure';
  }
}
