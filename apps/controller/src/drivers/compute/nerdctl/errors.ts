/**
 * Failures a caller must classify rather than retry: an unusable Configuration and a resource
 * this Driver does not own. They live in their own module so the Configuration schema and the
 * quantity parser can share one class without importing each other.
 */
export class ConfigurationFailure extends Error {}

export class OwnershipFailure extends Error {}

/** A tenant budget the Installation declares leaves no room for the requested containers. */
export class AdmissionFailure extends Error {}
