import { COMPOSITE_OPERATIONS } from "./composite.js";
import type { Operation } from "./operation.js";
import { READ_OPERATIONS } from "./read.js";
import { WRITE_OPERATIONS } from "./write.js";

export const OPERATIONS: Operation[] = [...READ_OPERATIONS, ...COMPOSITE_OPERATIONS, ...WRITE_OPERATIONS];
