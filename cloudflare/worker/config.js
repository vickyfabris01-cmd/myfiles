// cloudflare/worker/config.js
const MB = 1024 * 1024;

export const LIMITS = {
  MAX_IMAGE_BYTES: 20 * MB,
  MAX_VIDEO_BYTES: 500 * MB,
  MAX_THUMB_BYTES: 2 * MB,
  SINGLE_PUT_MAX: 50 * MB,      // at or below: one presigned PUT. above: multipart
  PART_SIZE: 16 * MB,           // every part except the last must be exactly this size
  UPLOAD_SESSION_TTL_MS: 12 * 3600 * 1000,   // an unfinished upload holds its reserved space until it expires
  UPLOAD_URL_SECONDS: 3600,
  DOWNLOAD_URL_SECONDS: 900,
  DELETE_GRACE_MS: 2 * 24 * 3600 * 1000,     // recycle bin: every deleted event, folder and file gets 2 days
  MAX_FOLDER_DEPTH: 12,
  PAGE_SIZE_DEFAULT: 60,
  PAGE_SIZE_MAX: 100,
  MANIFEST_MAX: 1000,
  MAX_ACTIVE_EVENTS: 5,         // per host; events in the bin do not count
  EVENTS_PER_HOUR: 20,          // anti-abuse: new events per host per hour
  UPLOADS_PER_MINUTE: 120,      // anti-abuse: new uploads per host per minute
  REPORT_MAX_CHARS: 1000,
  REPORTS_PER_EVENT_HOUR: 20,   // stops report flooding on one event
};

export const RATE = {            // requests per minute per IP (best effort, per isolate)
  validate: 30,
  public: 240,
  download: 120,
  admin: 600,
  report: 5,
};

export const OBJECT_KEYS = {
  original: (eventId, fileId) => `events/${eventId}/originals/${fileId}`,
  thumb: (eventId, fileId) => `events/${eventId}/thumbs/${fileId}.jpg`,
  // a hand-picked thumbnail gets a fresh key so browsers, caches and the share-preview collage all see the change
  thumbV: (eventId, fileId, tag) => `events/${eventId}/thumbs/${fileId}-${tag}.jpg`,
  prefix: (eventId) => `events/${eventId}/`,
};
