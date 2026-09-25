import type { RoomRegistrationStatus } from "@prisma/client";
import type { RoomRegistrationErrorCode } from "./errors";

// ─── Public snapshot returned by every service call ───────────────────
//
// A stable, minimal projection of the RoomRegistration row. The
// service NEVER returns the raw Prisma model — this shape is what
// callers (server actions) may render or serialize.
export type RoomRegistrationView = {
  id: string;
  participantId: string;
  accessPointId: string;
  status: RoomRegistrationStatus;
  registeredAt: Date;
  cancelledAt: Date | null;
};

// ─── Result shape ─────────────────────────────────────────────────────
export type Ok<T> = { ok: true; value: T };
export type Err = {
  ok: false;
  code: RoomRegistrationErrorCode;
  message: string;
};
export type ServiceResult<T> = Ok<T> | Err;

// ─── Input shapes ─────────────────────────────────────────────────────

export type InitRegistrationInput = {
  participantId: string;
  accessPointId: string;
};

export type CancelInput = {
  participantId: string;
  accessPointId: string;
  actorAdminId: string | null;
  reason?: string;
};
