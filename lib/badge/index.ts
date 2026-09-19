export {
  issueBadgeCredential,
  verifyBadgeToken,
  revokeBadgeCredential,
  rotateBadgeCredential,
  type IssueResult,
  type RotateResult,
  type RevokeResult,
  type VerifyResult
} from "./service";
export { BadgeError, type BadgeErrorCode } from "./errors";
