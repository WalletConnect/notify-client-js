export declare namespace JsonRpcTypes {
  export type WcMethod =
    | "wc_notifySubscribe"
    | "wc_notifyMessage"
    | "wc_notifyDelete"
    | "wc_notifyWatchSubscription"
    | "wc_notifySubscriptionsChanged"
    | "wc_notifyUpdate"
    | "wc_notifyGetUnreadNotificationsCount"
    | "wc_notifyReadNotification"
    | "wc_notifyGetNotifications"
    | "wc_notifyGetNotification";

  // ---- JSON-RPC Requests -----------------------------
  export interface RequestParams {
    wc_notifySubscribe: {
      subscriptionAuth: string;
    };
    wc_notifyMessage: {
      messageAuth: string;
    };
    wc_notifyDelete: {
      deleteAuth: string;
    };
    wc_notifyWatchSubscription: {
      watchSubscriptionsAuth: string;
    };
    wc_notifySubscriptionsChanged: {
      subscriptionsChangedAuth: string;
    };
    wc_notifyUpdate: {
      updateAuth: string;
    };
    wc_notifyGetNotifications: {
      auth: string
    };
    wc_notifyGetNotification: {
      auth: string
    };
    wc_notifyReadNotification: {
      auth: string
    };
    wc_notifyGetUnreadNotificationsCount: {
      auth: string
    };
  }

  // ---- JSON-RPC Responses -----------------------------
  export interface Results {
    wc_notifySubscribe: {
      responseAuth: string;
    };
    wc_notifyMessage: { responseAuth: string };
    wc_notifyDelete: {
      responseAuth: string;
    };
    wc_notifyWatchSubscription: {
      responseAuth: string;
    };
    wc_notifySubscriptionsChanged: {
      responseAuth: string;
    };
    wc_notifyUpdate: {
      responseAuth: string;
    };
    wc_notifyGetNotifications: {
      auth: string
    };
    wc_notifyGetNotification: {
      auth: string
    };
    wc_notifyReadNotification: {
      auth: string
    };
    wc_notifyGetUnreadNotificationsCount: {
      auth: string
    };
  }
}
