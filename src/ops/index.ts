import { CHAT_OPERATIONS } from "./chat.js";
import { COMPOSITE_OPERATIONS } from "./composite.js";
import { CONTENT_OPERATIONS } from "./content.js";
import { LIFECYCLE_OPERATIONS } from "./lifecycle.js";
import type { Operation } from "./operation.js";
import { READ_OPERATIONS } from "./read.js";
import { RELATION_OPERATIONS } from "./relations.js";
import { WRITE_OPERATIONS } from "./write.js";

export const OPERATIONS: Operation[] = [
  ...READ_OPERATIONS,
  ...COMPOSITE_OPERATIONS,
  ...WRITE_OPERATIONS,
  ...CHAT_OPERATIONS,
  ...CONTENT_OPERATIONS,
  ...RELATION_OPERATIONS,
  ...LIFECYCLE_OPERATIONS,
];
