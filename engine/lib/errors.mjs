export class KitError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'KitError';
    this.code = code;
    this.details = details;
  }
}
