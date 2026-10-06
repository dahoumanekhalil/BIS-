export {
  issueBadgeCredential,
  verifyBadgeToken,
  revokeBadgeCredential,
  regenerateBadgeCredential,
  getCurrentBadgeToken,
  type IssueResult,
  type RegenerateResult,
  type RevokeResult,
  type VerifyResult,
  type CurrentTokenResult
} from "./service";
export { BadgeError, type BadgeErrorCode } from "./errors";
