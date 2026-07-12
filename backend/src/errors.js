// Central error taxonomy for the API. Deliberate status-code convention
// (PROJECT_PLAN.md Section 3, Authorization Model): not authenticated -> 401;
// not a member of a workspace/channel -> 404, not 403, so a private
// resource's existence isn't confirmed to someone who can't access it;
// authenticated + a member but lacking a specific privilege (e.g. non-admin
// attempting an admin action) -> 403, since membership already establishes
// the resource is known to exist for that user.

export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class ValidationError extends AppError {
  constructor(message) {
    super(400, message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Not permitted') {
    super(403, message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(404, message);
  }
}

export class ConflictError extends AppError {
  constructor(message) {
    super(409, message);
  }
}

// Registered last in the middleware chain. Never leaks stack traces or raw
// driver errors to clients — logs the real error server-side instead.
export function errorHandler(err, _req, res, _next) {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  // eslint-disable-next-line no-console
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
}
