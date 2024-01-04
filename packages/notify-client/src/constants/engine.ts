import { FIVE_MINUTES, THIRTY_DAYS } from "@walletconnect/time";
import { JsonRpcTypes, RpcOpts } from "../types";

// JWT-related constants
export const JWT_SCP_SEPARATOR = " ";

export const NOTIFY_AUTHORIZATION_STATEMENT_ALL_DOMAINS =
  "I further authorize this app to view and manage my notifications for ALL apps. Read more at https://walletconnect.com/notifications-all-apps";
export const NOTIFY_AUTHORIZATION_STATEMENT_THIS_DOMAIN =
  "I further authorize this app to send me notifications. Read more at https://walletconnect.com/notifications";

export const DID_WEB_PREFIX = "did:web:";

// RPC Options
export const ENGINE_RPC_OPTS: Record<JsonRpcTypes.WcMethod, RpcOpts> = {
  wc_notifySubscribe: {
    req: {
      ttl: FIVE_MINUTES,
      tag: 4000,
    },
    res: {
      ttl: THIRTY_DAYS,
      tag: 4001,
    },
  },
  wc_notifyMessage: {
    req: {
      ttl: THIRTY_DAYS,
      tag: 4002,
    },
    res: {
      ttl: THIRTY_DAYS,
      tag: 4003,
    },
  },
  wc_notifyDelete: {
    req: {
      ttl: THIRTY_DAYS,
      tag: 4004,
    },
    res: {
      ttl: THIRTY_DAYS,
      tag: 4005,
    },
  },
  wc_notifyUpdate: {
    req: {
      ttl: FIVE_MINUTES,
      tag: 4008,
    },
    res: {
      ttl: THIRTY_DAYS,
      tag: 4009,
    },
  },
  wc_notifyWatchSubscription: {
    req: {
      ttl: FIVE_MINUTES,
      tag: 4010,
    },
    res: {
      ttl: FIVE_MINUTES,
      tag: 4011,
    },
  },
  wc_notifySubscriptionsChanged: {
    req: {
      ttl: FIVE_MINUTES,
      tag: 4012,
    },
    res: {
      ttl: FIVE_MINUTES,
      tag: 4013,
    },
  },
  wc_notifyGetNotifications: {
    req: {
      ttl: FIVE_MINUTES,
      tag:4014
    },
    res: {
      ttl: FIVE_MINUTES,
      tag:4015
    }
  },
  wc_notifyGetNotification: {
    req: {
      ttl: FIVE_MINUTES,
      tag:4016
    },
    res: {
      ttl: FIVE_MINUTES,
      tag:4017
    }
  },
  wc_notifyReadNotification: {
    req: {
      ttl: FIVE_MINUTES,
      tag:4020
    },
    res: {
      ttl: FIVE_MINUTES,
      tag:4021
    }
  },
  wc_notifyGetUnreadNotificationsCount: {
    req: {
      ttl: FIVE_MINUTES,
      tag:4022
    },
    res: {
      ttl: FIVE_MINUTES,
      tag:4023
    }
  }
};
