/** A failure with a definite HTTP status and a stable error code for clients. */
export class ApiFailure extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiFailure';
  }
}
