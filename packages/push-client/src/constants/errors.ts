export const SDK_ERRORS = {
  /* ----- INVALID (1xxx) ----- */
  INVALID_PROPOSAL: {
    message: "Invalid proposal.",
    code: 1000,
  },
  /* ----- REJECTED (5xxx) ----- */
  USER_REJECTED: {
    message: "User rejected.",
    code: 5000,
  },
  /* ----- REASON (6xxx) ----- */
  USER_UNSUBSCRIBED: {
    message: "User unsubscribed.",
    code: 6000,
  },
  /* ----- FAILURE (7xxx) ----- */
  APPROVAL_FAILED: {
    message: "Approval failed.",
    code: 7002,
  },
  REJECTION_FAILED: {
    message: "Rejection failed.",
    code: 7003,
  },
};
