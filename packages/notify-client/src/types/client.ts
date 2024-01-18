import { CacaoPayload } from "@walletconnect/cacao";
import { IdentityKeys } from "@walletconnect/identity-keys";
import { ErrorResponse } from "@walletconnect/jsonrpc-utils";
import { CoreTypes, ICore, IStore, RelayerTypes } from "@walletconnect/types";
import EventEmitter from "events";
import { Logger } from "pino";

import { INotifyEngine } from "./engine";

interface ImageUrls {
  sm: string;
  md: string;
  lg: string;
}

export declare namespace NotifyClientTypes {
  type Event =
    | "notify_subscription"
    | "notify_message"
    | "notify_delete"
    | "notify_update"
    | "notify_notifications_changed"
    | "notify_subscriptions_changed";

  type NotifyResponseEventArgs = {
    allSubscriptions?: NotifyClientTypes.NotifySubscription[];
    error?: ErrorResponse;
  };

  type NotifySubscriptionsChangedEventArgs = {
    subscriptions: NotifySubscription[];
  };

  type NotifyMessageRequestEventArgs = {
    message: NotifyClientTypes.NotifyMessage;
  };

  type NotifyDeleteRequestEventArgs = { id: number; topic: string };

  interface BaseEventArgs<T = unknown> {
    id: number;
    topic: string;
    params: T;
  }

  interface EventArguments {
    notify_subscription: BaseEventArgs<
      NotifyResponseEventArgs & {
        subscription?: NotifyClientTypes.NotifySubscription;
      }
    >;
    notify_message: BaseEventArgs<NotifyMessageRequestEventArgs>;
    notify_delete: BaseEventArgs<NotifyResponseEventArgs>;
    notify_update: BaseEventArgs<
      NotifyResponseEventArgs & {
        subscription?: NotifyClientTypes.NotifySubscription;
      }
    >;
    notify_subscriptions_changed: BaseEventArgs<NotifySubscriptionsChangedEventArgs>;
    notify_notifications_changed: BaseEventArgs<{
      notifications: NotifyMessage[];
    }>;
  }

  interface BaseJwtClaims {
    act: string; // action intent
    iat: number; // issued at
    exp: number; // expiry
    ksu: string; // key server url
  }

  interface ClientOptions extends CoreTypes.Options {
    core?: ICore;
    keyserverUrl?: string;
    identityKeys?: IdentityKeys;
  }

  interface Metadata {
    name: string;
    description: string;
    icons: string[];
    appDomain: string;
  }

  type ScopeMap = Record<
    string,
    {
      name: string;
      id: string;
      description: string;
      enabled: boolean;
      imageUrls: ImageUrls;
    }
  >;

  interface NotifyRegistrationParams {
    cacaoPayload: CacaoPayload;
    privateIdentityKey: Uint8Array;
  }

  interface NotifySubscription {
    topic: string;
    account: string;
    relay: RelayerTypes.ProtocolOptions;
    appAuthenticationKey: string;
    metadata: Metadata;
    scope: ScopeMap;
    expiry: number;
    symKey: string;
  }

  interface NotifyServerSubscription {
    appDomain: string;
    scope: string[];
    appAuthenticationKey: string;
    account: string;
    symKey: string;
    expiry: number;
  }

  interface NotifyServerMessage {
    title: string;
    sent_at: number;
    body: string;
    id: string;
    url: string;
    type: string;
    read: boolean;
  }

  interface NotifyMessage {
    title: string;
    sentAt: number;
    body: string;
    id: string;
    url: string;
    type: string;
    read: boolean;
  }

  interface NotifyMessageRecord {
    id: number;
    topic: string;
    message: NotifyMessage;
    publishedAt: number;
  }

  interface GetNotificationsJwtClaims extends BaseJwtClaims {
    act: "notify_get_notifications";
    sub: string; // did:pkh of blockchain account that this notify subscription is associated with
    aud: string; // did:key of client identity key
    iss: string; // did:key of an identity key. Enables to resolve attached blockchain account.
    app: string; // did web domain url,
    urf: boolean; // unread first
    lmt: number; // max number of notifications
    aft: string | null; // notification to start returning messages after,
  }

  interface SubscriptionJWTClaims extends BaseJwtClaims {
    act: "notify_subscription"; // action intent (must be "notify_subscription")
    iss: string; // did:key of client identity key
    ksu: string; // key server for identity key verification
    aud: string; // did:key of client identity key
    sub: string; // did:pkh of blockchain account that this notify subscription is associated with
    scp: string; // scope of notification types authorized by the user
    app: string; // dapp's domain URL
  }

  interface MessageJWTClaims extends BaseJwtClaims {
    act: "notify_message"; // action intent (must be "notify_message")
    iss: string; // public key of cast server (did:key)
    sub: string; // did:pkh of blockchain account that this notify subscription is associated with
    app: string; // dapp domain url,
    msg: NotifyMessage;
  }

  interface MessageResponseJWTClaims extends BaseJwtClaims {
    act: "notify_message_response"; // description of action intent. Must be equal to "notify_message_response"
    iss: string; // did:key of an identity key. Enables to resolve attached blockchain account.
    aud: string; // did:key of an identity key. Enables to resolve associated Dapp domain used.
    sub: string; // did:pkh of blockchain account that this notify subscription is associated with
    app: string; // dapp's domain url
  }

  interface UpdateJWTClaims extends BaseJwtClaims {
    act: "notify_update"; // description of action intent. Must be equal to "notify_update"
    iss: string; // did:key of an identity key. Enables to resolve attached blockchain account.
    aud: string; // did:key of an identity key. Enables to resolve associated Dapp domain used.
    sub: string; // blockchain account that this notify subscription is associated with (did:pkh)
    scp: string; // scope of notification types authorized by the user
    app: string; // dapp's domain url
  }

  interface DeleteJWTClaims extends BaseJwtClaims {
    act: "notify_delete"; // description of action intent. Must be equal to "notify_delete"
    iss: string; // did:key of an identity key. Enables to resolve attached blockchain account.
    aud: string; //did:key of an identity key. Enables to resolve associated Dapp domain used.
    sub: string; // did:pkh of blockchain account that this notify subscription is associated with
    app: string; // dapp's domain url
  }

  interface NotifyWatchSubscriptionsClaims extends BaseJwtClaims {
    act: "notify_watch_subscriptions";
    iss: string; // did:key of client identity key
    ksu: string; // keyserver url
    aud: string; // did:key of notify server identity key
    sub: string; // did:pkh of blockchain account that this notify subscription is associated with
    app: string | null; // did:web of app domain to watch, or `null` for all domains
  }

  interface NotifySubscriptionsChangedClaims extends BaseJwtClaims {
    act: "notify_subscriptions_changed";
    iss: string; // did:key of notify server identity key
    aud: string; // did:pkh blockchain account that notify subscription is associated with
    sub: string; // did:pkh of blockchain account that this notify subscription is associated with
    sbs: NotifyServerSubscription[]; // array of [Notify Server Subscriptions]
  }

  interface MarkNotificationQAsReadClaims extends BaseJwtClaims {
    act: "notify_read_notifications";
    iss: string; // did:key of client identity key
    ksu: string; // keyserver url
    aud: string; // did:key of dapp authentication key
    app: string; // did:web of app domain that this request is associated with
    sub: string; // did:pkh of blockchain account that this notify subscription is associated with
    ids: string[]; // array of notification IDs to mark as read, max 1000 items
  }

  interface CommonResponseJWTClaims extends BaseJwtClaims {
    iss: string; // did:key of an identity key. Enables to resolve attached blockchain account.
    aud: string; //did:key of an identity key. Enables to resolve associated Dapp domain used.
    sub: string; // did:pkh of blockchain account that this notify subscription is associated with
    app: string; // dapp's domain url
  }

  interface SubscriptionResponseJWTClaims extends CommonResponseJWTClaims {
    act: "notify_subscription_response";
    sbs: NotifyServerSubscription[]; // array of [Notify Server Subscriptions]
  }

  interface UpdateResponseJWTClaims extends CommonResponseJWTClaims {
    act: "notify_update_response";
    sbs: NotifyServerSubscription[]; // array of [Notify Server Subscriptions]
  }

  interface DeleteResponseJWTClaims extends CommonResponseJWTClaims {
    act: "notify_delete_response";
    sbs: NotifyServerSubscription[]; // array of [Notify Server Subscriptions]
  }

  interface GetNotificationsResponseClaims extends BaseJwtClaims {
    act: "notify_get_notifications_response";
    iss: string; // did:key of notify server identity key
    aud: string; // did:key of client identity key
    mur: boolean; // more unread
    mre: boolean; // more pages
    nfs: NotifyServerMessage[];
  }

  interface NotificationChangedClaims extends BaseJwtClaims {
    act: "notify_notification_changed";
    iss: string; // did:key of notify server identity key
    aud: string; // did:key of client identity key
    nfn: NotifyServerMessage[];
  }

  interface NotifyWatchSubscriptionsResponseClaims extends BaseJwtClaims {
    act: "notify_watch_subscriptions_response";
    iss: string; // did:key of notify server identity key
    aud: string; // did:key of client identity key
    sub: string; // did:key of the public key used for key agreement on the Notify topic
    sbs: NotifyServerSubscription[]; // array of [Notify Server Subscriptions]
  }

  interface NotifySubscriptionsChangedResponseClaims extends BaseJwtClaims {
    act: "notify_subscriptions_changed_response";
    iss: string; // did:key of notify server identity key
    aud: string; // did:key of client identity key
    sub: string; // did:key of the public key used for key agreement on the Notify topic
    sbs: Omit<NotifySubscription, "relay">[]; // array of [Notify Server Subscriptions]
  }

  interface NotifyDidDocument {
    "@context": string[];
    id: string;
    verificationMethod: Array<{
      id: string;
      type: string;
      controller: string;
      publicKeyJwk: {
        kty: string;
        crv: string;
        x: string;
      };
    }>;
    keyAgreement: string[];
    authentication: string[];
  }

  interface NotifyConfigDocument {
    id: string;
    name: Metadata["name"];
    notificationTypes: Array<{
      id: string;
      name: string;
      imageUrls: ImageUrls;
      image_id: string;
      description: string;
    }>;
    description: Metadata["description"];
    image_url?: {
      sm: string;
      md: string;
      lg: string;
    };
  }
}

export abstract class INotifyClient {
  public abstract readonly protocol: string;
  public abstract readonly version: number;
  public abstract readonly name: string;
  public abstract readonly keyserverUrl: string;
  public abstract readonly notifyServerUrl: string;

  public abstract core: ICore;
  public abstract events: EventEmitter;
  public abstract logger: Logger;
  public abstract engine: INotifyEngine;

  public abstract registrationData: IStore<
    string,
    { statement: string; account: string; domain: string }
  >;

  public abstract watchedAccounts: IStore<
    string,
    {
      allApps: boolean;
      appDomain: string;
      resTopic: string;
      account: string;
      privateKeyY: string;
      publicKeyY: string;
      lastWatched: boolean;
    }
  >;

  public abstract identityKeys: IdentityKeys;

  public abstract subscriptions: IStore<
    string,
    NotifyClientTypes.NotifySubscription
  >;

  constructor(public opts: NotifyClientTypes.ClientOptions) {}

  // ---------- Public Methods ------------------------------------------------------- //

  public abstract isRegistered: INotifyEngine["isRegistered"];
  public abstract prepareRegistration: INotifyEngine["prepareRegistration"];
  public abstract register: INotifyEngine["register"];
  public abstract unregister: INotifyEngine["unregister"];
  public abstract subscribe: INotifyEngine["subscribe"];
  public abstract update: INotifyEngine["update"];
  public abstract decryptMessage: INotifyEngine["decryptMessage"];
  public abstract getNotificationHistory: INotifyEngine["getNotificationHistory"];
  public abstract getActiveSubscriptions: INotifyEngine["getActiveSubscriptions"];
  public abstract deleteSubscription: INotifyEngine["deleteSubscription"];

  // Flag is used for consumers of the SDK to know if notify client finished loading
  // since the event below might be emitted before `init` resolves.
  public abstract hasFinishedInitialLoad: INotifyEngine["hasFinishedInitialLoad"];

  // ---------- Event Handlers ------------------------------------------------------- //

  public abstract emit: <E extends NotifyClientTypes.Event>(
    event: E,
    args: NotifyClientTypes.EventArguments[E]
  ) => boolean;

  public abstract on: <E extends NotifyClientTypes.Event>(
    event: E,
    listener: (args: NotifyClientTypes.EventArguments[E]) => void
  ) => EventEmitter;

  public abstract once: <E extends NotifyClientTypes.Event>(
    event: E,
    listener: (args: NotifyClientTypes.EventArguments[E]) => void
  ) => EventEmitter;

  public abstract off: <E extends NotifyClientTypes.Event>(
    event: E,
    listener: (args: NotifyClientTypes.EventArguments[E]) => void
  ) => EventEmitter;

  public abstract removeListener: <E extends NotifyClientTypes.Event>(
    event: E,
    listener: (args: NotifyClientTypes.EventArguments[E]) => void
  ) => EventEmitter;
}
