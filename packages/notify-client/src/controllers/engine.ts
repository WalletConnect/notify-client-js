import { RELAYER_DEFAULT_PROTOCOL, RELAYER_EVENTS } from "@walletconnect/core";
import {
  JwtPayload,
  composeDidPkh,
  encodeEd25519Key,
  decodeEd25519Key,
} from "@walletconnect/did-jwt";
import {
  JsonRpcPayload,
  formatJsonRpcError,
  formatJsonRpcRequest,
  formatJsonRpcResult,
  isJsonRpcError,
  isJsonRpcRequest,
  isJsonRpcResponse,
  isJsonRpcResult,
} from "@walletconnect/jsonrpc-utils";
import {
  FIVE_MINUTES,
  ONE_DAY,
  THIRTY_MINUTES,
  THIRTY_SECONDS,
} from "@walletconnect/time";
import { JsonRpcRecord, RelayerTypes } from "@walletconnect/types";
import {
  TYPE_1,
  deriveSymKey,
  getInternalError,
  hashKey,
} from "@walletconnect/utils";
import axios from "axios";
import jwtDecode, { InvalidTokenError } from "jwt-decode";

import {
  DEFAULT_EXPLORER_API_URL,
  DID_WEB_PREFIX,
  ENGINE_RPC_OPTS,
  JWT_SCP_SEPARATOR,
  NOTIFY_AUTHORIZATION_STATEMENT_ALL_DOMAINS,
  NOTIFY_AUTHORIZATION_STATEMENT_THIS_DOMAIN,
  NOTIFY_CLIENT_PACKAGE_MANAGER,
} from "../constants";
import {
  INotifyEngine,
  JsonRpcTypes,
  NotifyClientTypes,
  NotifyEngineTypes,
} from "../types";
import { getCaip10FromDidPkh } from "../utils/address";
import { getDappUrl } from "../utils/formats";

export class NotifyEngine extends INotifyEngine {
  public name = "notifyEngine";
  private initialized = false;

  private lastWatchSubscriptionsCallTimestamp: number;
  private disconnectTimer: number;

  private finishedInitialLoad = false;

  private didDocMap = new Map<string, NotifyClientTypes.NotifyDidDocument>();

  constructor(client: INotifyEngine["client"]) {
    super(client);

    // 0 since it has not been called yet
    this.lastWatchSubscriptionsCallTimestamp = 0;
    this.disconnectTimer = 0;
  }

  public init: INotifyEngine["init"] = async () => {
    if (!this.initialized) {
      this.registerRelayerEvents();
      this.client.core.pairing.register({
        methods: Object.keys(ENGINE_RPC_OPTS),
      });

      await this.watchLastWatchedAccountIfExists();

      this.initialized = true;

      this.client.core.relayer.on(RELAYER_EVENTS.disconnect, () => {
        // Do not reset the timer if we're already disconnected
        // as multiple disconnect events are emitted even when disconnected
        if (!this.disconnectTimer) {
          this.disconnectTimer = Date.now();
        }
      });

      this.client.core.relayer.on(RELAYER_EVENTS.connect, () => {
        // If client has been offline for more than 5 minutes - call watch subscriptions
        const timeSinceOffline = Date.now() - this.disconnectTimer;

        // Allow for margin for error
        const timeSinceOfflineTolerance = THIRTY_SECONDS * 1_000;

        const offlineForMoreThan5Minutes =
          timeSinceOffline + timeSinceOfflineTolerance >= FIVE_MINUTES * 1_000;

        this.disconnectTimer = 0;

        if (offlineForMoreThan5Minutes) {
          this.watchLastWatchedAccountIfExists();
        }

        const timeSinceFirstWatchSubscriptions =
          Date.now() - this.lastWatchSubscriptionsCallTimestamp;

        const timeSinceFirstWatchSubscriptionsTolerance =
          THIRTY_MINUTES * 1_000;

        const clientOnlineForOverADay =
          timeSinceFirstWatchSubscriptions +
            timeSinceFirstWatchSubscriptionsTolerance >
          ONE_DAY * 1_000;

        // Call watch subscriptionsevery 24 hours
        // This check will be triggered every reconnect
        if (clientOnlineForOverADay) {
          this.watchLastWatchedAccountIfExists();
          this.lastWatchSubscriptionsCallTimestamp = 0;
        }
      });
    }
  };

  // ---------- Public --------------------------------------- //

  public hasFinishedInitialLoad: INotifyEngine["hasFinishedInitialLoad"] =
    () => {
      return this.finishedInitialLoad;
    };

  public prepareRegistrationWithRecaps: INotifyEngine["prepareRegistrationWithRecaps"] =
    async (params) => {
      const baseRegisterParams =
        await this.client.identityKeys.prepareRegistrationWithRecaps({
          domain: params.domain,
          recapObject: {
            att: {
              "https://notify.walletconnect.com": params.allApps
                ? {
                    "manage/all-apps-notifications": [{}],
                  }
                : {
                    [`manage/${params.domain}-notifications`]: [{}],
                  },
            },
          },
        });

      return {
        ...baseRegisterParams,
        allApps: params.allApps ?? false,
      };
    };

  public prepareRegistration: INotifyEngine["prepareRegistration"] = async ({
    account,
    domain,
    allApps,
  }) => {
    const statement = allApps
      ? NOTIFY_AUTHORIZATION_STATEMENT_ALL_DOMAINS
      : NOTIFY_AUTHORIZATION_STATEMENT_THIS_DOMAIN;

    const baseRegisterParams =
      await this.client.identityKeys.prepareRegistration({
        accountId: account,
        domain,
        statement,
      });

    return {
      message: baseRegisterParams.message,
      registerParams: {
        cacaoPayload: baseRegisterParams.registerParams.cacaoPayload,
        privateIdentityKey:
          baseRegisterParams.registerParams.privateIdentityKey,
        allApps: allApps ?? false,
      },
    };
  };

  // Checks if user is registered and has up to date registration data.
  public isRegistered: INotifyEngine["isRegistered"] = ({
    account,
    allApps,
    domain,
  }) => {
    if (this.client.identityKeys.isRegistered(account)) {
      return !this.checkIfIdentityIsStale(
        account,
        allApps
          ? NOTIFY_AUTHORIZATION_STATEMENT_ALL_DOMAINS
          : NOTIFY_AUTHORIZATION_STATEMENT_THIS_DOMAIN,
        domain
      );
    }

    return false;
  };

  public register: INotifyEngine["register"] = async ({
    registerParams,
    signature,
    signatureType,
  }) => {
    // Retrieve existing identity or register a new one for this account on this device.
    const identity = await this.registerIdentity({
      registerParams,
      signature,
      signatureType,
    });

    const allApps =
      registerParams.allApps ||
      registerParams.cacaoPayload.statement ===
        NOTIFY_AUTHORIZATION_STATEMENT_ALL_DOMAINS;

    const domain = registerParams.cacaoPayload.domain;
    const account = getCaip10FromDidPkh(registerParams.cacaoPayload.iss);

    try {
      await this.watchSubscriptions(account, domain, allApps);
    } catch (error: any) {
      this.client.logger.error(
        `[Notify] Engine.register > watching subscriptions failed > ${error.message}`
      );
    }

    return identity;
  };

  public unregister: INotifyEngine["unregister"] = async ({ account }) => {
    try {
      if (!(await this.client.identityKeys.hasIdentity({ account }))) {
        return;
      }

      // If user has watched their subscriptions before, stop watching.
      // We can not assume that every registered user has a watchedAccount
      // due to the fact that the stores for watchedAccounts and identityKeys
      // are entirely separate.
      if (this.client.watchedAccounts.keys.includes(account)) {
        const watchedAccount = this.client.watchedAccounts.get(account);

        // If account was watched: stop watching it.
        if (watchedAccount) {
          this.client.logger.info(
            `[Notify] unregister > account ${watchedAccount.account} was previously watched. Unsubscribing from watch topics`
          );
          // and subscribed to a notify server watch topic
          if (
            await this.client.core.relayer.subscriber.isSubscribed(
              watchedAccount.resTopic
            )
          ) {
            // unsubscribe from watch topic
            await this.client.core.relayer.unsubscribe(watchedAccount.resTopic);
          }

          // If account was the last to be watched
          if (watchedAccount.lastWatched) {
            // Remove last watched flag, to prevent watching on next init.
            await this.client.watchedAccounts.update(watchedAccount.account, {
              lastWatched: false,
            });
            this.client.logger.info(
              `[Notify] unregister > account ${watchedAccount.account} was last to be watched. Unmarking as last watched`
            );
          }
        }
      }

      // Unsubscribe from subscription topics
      for (const sub of Object.values(
        this.getActiveSubscriptions({ account })
      )) {
        await this.client.core.relayer.unsubscribe(sub.topic);
      }

      // unregister from identity server
      await this.client.identityKeys.unregisterIdentity({ account });

      // If user has registration data, clear it to prevent false
      // data regarding staleness of identity
      if (this.client.registrationData.keys.includes(account)) {
        this.client.registrationData.delete(account, {
          code: -1,
          message: "Wallet was unregistered",
        });
      }

      this.client.logger.info(
        `Engine.unregister > Successfully unregistered account ${account}`
      );
    } catch (error: any) {
      this.client.logger.error(
        `[Notify] Engine.unregister > failed to unregister > ${error.message}`
      );
    }
  };

  public subscribe: INotifyEngine["subscribe"] = async ({
    appDomain,
    account,
  }) => {
    this.isInitialized();

    // Not using `this.isRegistered` because that accounts for stale
    // statements, and we don't want stale statements to block users
    // from subscribing.
    if (!this.client.identityKeys.isRegistered(account)) {
      throw new Error(`Account ${account} is not registered.`);
    }

    const dappUrl = getDappUrl(appDomain);
    const { dappPublicKey, dappIdentityKey } = await this.resolveKeys(dappUrl);
    const notifyConfig = await this.resolveNotifyConfig(appDomain);

    this.client.logger.info(
      `[Notify] subscribe > publicKey for ${dappUrl} is: ${dappPublicKey}`
    );

    // SPEC: Wallet derives subscribe topic, which is the sha256 hash of public key X
    const subscribeTopic = hashKey(dappPublicKey);

    // SPEC: Wallet generates key pair Y
    const selfPublicKey = await this.client.core.crypto.generateKeyPair();

    // SPEC: Wallet derives S symmetric key with keys X and Y
    const responseTopic = await this.client.core.crypto.generateSharedKey(
      selfPublicKey,
      dappPublicKey
    );

    // SPEC: Generate a subscriptionAuth JWT
    const identityKeyPub = await this.client.identityKeys.getIdentity({
      account,
    });
    const issuedAt = Math.round(Date.now() / 1000);
    const expiry = issuedAt + ENGINE_RPC_OPTS["wc_notifySubscribe"].req.ttl;
    const scp =
      notifyConfig?.notificationTypes
        .map((type) => type.id)
        .join(JWT_SCP_SEPARATOR) ?? "";

    const payload: NotifyClientTypes.SubscriptionJWTClaims = {
      iat: issuedAt,
      exp: expiry,
      iss: encodeEd25519Key(identityKeyPub),
      sub: composeDidPkh(account),
      aud: encodeEd25519Key(dappIdentityKey),
      ksu: this.client.keyserverUrl,
      scp,
      act: "notify_subscription",
      app: `${DID_WEB_PREFIX}${appDomain}`,
      mjv: "1",
      sdk: {
        packageManager: NOTIFY_CLIENT_PACKAGE_MANAGER,
        packages: {
          ...this.client.sdkVersionMap,
        },
      },
    };

    this.client.logger.info(
      `[Notify] subscribe > generating subscriptionAuth JWT for payload: ${JSON.stringify(
        payload
      )}`
    );

    const subscriptionAuth = await this.generateSubscriptionAuth(
      account,
      payload
    );

    this.client.logger.info(
      `[Notify] subscribe > generated subscriptionAuth JWT: ${subscriptionAuth}`
    );

    // SPEC: Wallet subscribes to response topic
    await this.client.core.relayer.subscribe(responseTopic);

    this.client.logger.info(
      `[Notify] subscribe > subscribed to responseTopic ${responseTopic}`
    );

    this.client.logger.info(
      `[Notify] subscribe > sending wc_notifySubscribe request on topic ${subscribeTopic}...`
    );

    return new Promise<boolean>((resolve) => {
      const listener = (
        args: NotifyClientTypes.EventArguments["notify_subscription"]
      ) => {
        if (args.topic !== responseTopic) {
          return;
        }
        this.client.off("notify_subscription", listener);
        if (args.params.error) {
          resolve(false);
        } else {
          resolve(true);
        }
      };

      this.client.on("notify_subscription", listener);

      // SPEC: Wallet sends wc_notifySubscribe request (type 1 envelope) on subscribe topic with subscriptionAuth
      this.sendRequest<"wc_notifySubscribe">(
        subscribeTopic,
        "wc_notifySubscribe",
        {
          subscriptionAuth,
        },
        {
          type: TYPE_1,
          senderPublicKey: selfPublicKey,
          receiverPublicKey: dappPublicKey,
        }
      ).then((id) => {
        this.client.logger.info({
          action: "sendRequest",
          method: "wc_notifySubscribe",
          id,
          topic: subscribeTopic,
          subscriptionAuth,
          params: {
            type: TYPE_1,
            senderPublicKey: selfPublicKey,
            receiverPublicKey: dappPublicKey,
          },
        });
      });
    });
  };

  public update: INotifyEngine["update"] = async ({ topic, scope }) => {
    this.isInitialized();

    this.client.logger.info(
      `[Notify] update > updating notify subscription for topic ${topic} with new scope: ${JSON.stringify(
        scope
      )}`
    );

    let subscription: NotifyClientTypes.NotifySubscription;

    // Retrieves the known subscription for the given topic or throws if no subscription is found.
    try {
      subscription = this.client.subscriptions.get(topic);
    } catch (error) {
      throw new Error(
        `update(): No subscription found to update for the given topic: ${topic}`
      );
    }

    const updateAuth = await this.generateUpdateAuth({ subscription, scope });

    this.client.logger.info(
      `[Notify] update > generated updateAuth JWT: ${updateAuth}`
    );

    return new Promise<boolean>((resolve, reject) => {
      const listener = (
        args: NotifyClientTypes.EventArguments["notify_update"]
      ) => {
        if (args.topic !== topic) {
          return;
        }
        this.client.off("notify_update", listener);

        if (args.params.error) {
          reject(args.params.error);
        } else {
          resolve(true);
        }
      };

      this.client.on("notify_update", listener);

      this.sendRequest(topic, "wc_notifyUpdate", {
        updateAuth,
      }).then((id) => {
        this.client.logger.info({
          action: "sendRequest",
          method: "wc_notifyUpdate",
          id,
          topic,
          updateAuth,
        });
      });
    });
  };

  public getNotificationHistory: INotifyEngine["getNotificationHistory"] =
    async ({ topic, limit, startingAfter, unreadFirst }) => {
      this.isInitialized();

      if (!this.client.subscriptions.keys.includes(topic)) {
        throw new Error(`No subscription with topic ${topic} exists`);
      }

      const subscription = this.client.subscriptions.get(topic);

      const identityKey = encodeEd25519Key(
        await this.client.identityKeys.getIdentity({
          account: subscription.account,
        })
      );

      const issuedAt = Math.round(Date.now() / 1000);
      const expiry =
        issuedAt + ENGINE_RPC_OPTS["wc_notifyGetNotifications"].req.ttl;

      const cachedKey = this.getCachedDappKey(subscription);
      const dappUrl = getDappUrl(subscription.metadata.appDomain);
      const { dappIdentityKey } = cachedKey
        ? { dappIdentityKey: cachedKey }
        : await this.resolveKeys(dappUrl);

      const getNotificationsClaims: NotifyClientTypes.GetNotificationsJwtClaims =
        {
          act: "notify_get_notifications",
          aft: startingAfter ?? null,
          iss: identityKey,
          ksu: this.client.keyserverUrl,
          sub: composeDidPkh(subscription.account),
          iat: issuedAt,
          exp: expiry,
          aud: encodeEd25519Key(dappIdentityKey),
          app: `${DID_WEB_PREFIX}${subscription.metadata.appDomain}`,
          lmt: limit ?? 50,
          urf: unreadFirst ?? true,
          mjv: "1",
          sdk: {
            packageManager: NOTIFY_CLIENT_PACKAGE_MANAGER,
            packages: {
              ...this.client.sdkVersionMap,
            },
          },
        };

      const auth = await this.client.identityKeys.generateIdAuth(
        subscription.account,
        getNotificationsClaims
      );

      return new Promise((resolve, reject) => {
        const listener = (
          args: NotifyEngineTypes.EventArguments["notify_get_notifications_response"]
        ) => {
          if (args.topic !== topic) {
            return;
          }

          this.off("notify_get_notifications_response", listener);

          if (args.error === null) {
            resolve(args);
          } else {
            reject(new Error(args.error));
          }
        };

        this.on("notify_get_notifications_response", listener);

        // Add timeout to prevent memory leaks with unresolving promises
        setTimeout(() => {
          reject(
            new Error("getNotificationHistory timed out waiting for a response")
          );
          // Using five minutes as it is the TTL of wc_getNotificationHistory
          // The FIVE_MINUTES const is in seconds, not ms.
        }, FIVE_MINUTES * 1000);

        this.sendRequest(topic, "wc_notifyGetNotifications", { auth });
      });
    };

  public markNotificationsAsRead: INotifyEngine["markNotificationsAsRead"] =
    async ({ topic, notificationIds }) => {
      return this.readNotifications({ topic, notificationIds, all: false });
    };

  public markAllNotificationsAsRead: INotifyEngine["markAllNotificationsAsRead"] =
    async ({ topic }) => {
      return this.readNotifications({
        topic,
        notificationIds: null,
        all: true,
      });
    };

  public decryptMessage: INotifyEngine["decryptMessage"] = async ({
    topic,
    encryptedMessage,
  }) => {
    this.isInitialized();

    try {
      const payload: JsonRpcPayload<
        JsonRpcTypes.RequestParams["wc_notifyMessage"]
      > = await this.client.core.crypto.decode(topic, encryptedMessage);

      if (!("params" in payload)) {
        throw new Error(
          "Invalid message payload provided to `decryptMessage`: expected `params` key to be present."
        );
      }

      if (!("messageAuth" in payload.params)) {
        throw new Error(
          "Invalid message payload provided to `decryptMessage`: expected `messageAuth` key to be present."
        );
      }

      const messageClaims =
        this.decodeAndValidateJwtAuth<NotifyClientTypes.MessageJWTClaims>(
          payload.params.messageAuth,
          "notify_message"
        );

      return messageClaims.msg;
    } catch (error: any) {
      throw new Error(
        `Could not decode payload "${encryptedMessage}" on topic ${topic}: ${
          error.message || error
        }`
      );
    }
  };

  public deleteSubscription: INotifyEngine["deleteSubscription"] = async ({
    topic,
  }) => {
    this.isInitialized();

    const deleteAuth = await this.generateDeleteAuth({
      topic,
    });

    return new Promise<void>((resolve, reject) => {
      const listener = (
        args: NotifyClientTypes.EventArguments["notify_delete"]
      ) => {
        if (args.topic !== topic) {
          return;
        }
        this.client.off("notify_delete", listener);
        if (args.params.error) {
          reject(args.params.error);
        } else {
          resolve();
        }
      };

      this.client.on("notify_delete", listener);

      this.sendRequest(topic, "wc_notifyDelete", { deleteAuth }).then(() => {
        this.client.logger.info(
          `[Notify] Engine.delete > deleted notify subscription on topic ${topic}`
        );
      });
    });
  };

  public deleteNotifyMessage: INotifyEngine["deleteNotifyMessage"] = ({
    id,
  }) => {
    this.isInitialized();

    const targetRecord = this.client.messages
      .getAll()
      .find((record) => record.messages[id]);

    if (!targetRecord) {
      throw new Error(
        `No message with id ${id} found in notify message history.`
      );
    }

    delete targetRecord.messages[id];

    this.client.messages.update(targetRecord.topic, targetRecord);
  };

  public getNotificationTypes: INotifyEngine["getNotificationTypes"] = (
    params
  ) => {
    this.isInitialized();

    const subscriptions = this.getActiveSubscriptions();

    const specifiedSubscription = Object.values(subscriptions).find(
      (subscription) => subscription.metadata.appDomain === params.appDomain
    );

    if (!specifiedSubscription) {
      throw new Error(
        `[Notify] No subscription found with domain ${params.appDomain})`
      );
    }

    return specifiedSubscription.scope;
  };

  public getActiveSubscriptions: INotifyEngine["getActiveSubscriptions"] = (
    params
  ) => {
    this.isInitialized();

    const subscriptions = this.client.subscriptions
      .getAll(params)
      .map((subscription) => [subscription.topic, subscription]);

    return Object.fromEntries(subscriptions);
  };

  // ---------- Protected Helpers --------------------------------------- //
  protected sendRequest: INotifyEngine["sendRequest"] = async (
    topic,
    method,
    params,
    encodeOpts
  ) => {
    const payload = formatJsonRpcRequest(method, params);
    const message = await this.client.core.crypto.encode(
      topic,
      payload,
      encodeOpts
    );
    const rpcOpts = ENGINE_RPC_OPTS[method].req;
    this.client.core.history.set(topic, payload);
    await this.client.core.relayer.publish(topic, message, rpcOpts);

    this.client.logger.info({
      action: "sendRequest",
      id: payload.id,
      messageHash: message,
    });

    return payload.id;
  };

  protected sendResult: INotifyEngine["sendResult"] = async (
    id,
    topic,
    result,
    encodeOpts
  ) => {
    // If the initial request is not in the history, do not attempt to send a result.
    // E.g. receiving a `wc_notifyMessage` res sent by another client before this client
    // processes/receives the initial req.
    if (!this.client.core.history.keys.includes(id)) {
      this.client.logger.info(
        `[Notify] Engine.sendResult > ignoring result for unknown request id ${id} without history record on topic ${topic}.`
      );
      return id;
    }
    const payload = formatJsonRpcResult(id, result);
    const message = await this.client.core.crypto.encode(
      topic,
      payload,
      encodeOpts
    );
    const record = await this.client.core.history.get(topic, id);
    const rpcOpts = ENGINE_RPC_OPTS[record.request.method].res;

    await this.client.core.relayer.publish(topic, message, rpcOpts);
    await this.client.core.history.resolve(payload);
    this.client.core.history.delete(topic, payload.id);

    return payload.id;
  };

  protected sendError: INotifyEngine["sendError"] = async (
    id,
    topic,
    params,
    encodeOpts
  ) => {
    const payload = formatJsonRpcError(id, params);
    const message = await this.client.core.crypto.encode(
      topic,
      payload,
      encodeOpts
    );
    const record = await this.client.core.history.get(topic, id);
    const rpcOpts = ENGINE_RPC_OPTS[record.request.method].res;

    await this.client.core.relayer.publish(topic, message, rpcOpts);
    await this.client.core.history.resolve(payload);
    this.client.core.history.delete(topic, payload.id);

    return payload.id;
  };

  // ---------- Relay Events Router ----------------------------------- //

  private registerRelayerEvents() {
    this.client.core.relayer.on(
      RELAYER_EVENTS.message,
      async (event: RelayerTypes.MessageEvent) => {
        const { topic, message, publishedAt } = event;

        const payload = await this.client.core.crypto.decode(topic, message);

        if (isJsonRpcRequest(payload)) {
          this.client.core.history.set(topic, payload);
          this.onRelayEventRequest({
            topic,
            payload,
            publishedAt,
          });
        } else if (isJsonRpcResponse(payload)) {
          await this.client.core.history.resolve(payload);
          await this.onRelayEventResponse({
            topic,
            payload,
            publishedAt,
          });
          this.client.core.history.delete(topic, payload.id);
        }
      }
    );
  }

  protected onRelayEventRequest: INotifyEngine["onRelayEventRequest"] = (
    event
  ) => {
    const { topic, payload, publishedAt } = event;
    const reqMethod = payload.method as JsonRpcTypes.WcMethod;

    switch (reqMethod) {
      case "wc_notifyMessage":
        return this.onNotifyMessageRequest(topic, payload, publishedAt);
      case "wc_notifySubscriptionsChanged":
        return this.onNotifySubscriptionsChangedRequest(topic, payload);
      default:
        return this.client.logger.info(
          `[Notify] Unsupported request method ${reqMethod}`
        );
    }
  };

  protected onRelayEventResponse: INotifyEngine["onRelayEventResponse"] =
    async (event) => {
      const { topic, payload } = event;
      let record: JsonRpcRecord;

      if (this.client.core.history.keys.includes(payload.id)) {
        record = await this.client.core.history.get(topic, payload.id);
      } else {
        this.client.logger.info(
          "[Notify] Engine.onRelayEventResponse > ignoring response for unknown request without history record."
        );
        return;
      }

      const resMethod = record.request.method as JsonRpcTypes.WcMethod;

      switch (resMethod) {
        case "wc_notifySubscribe":
          return this.onNotifySubscribeResponse(topic, payload);
        case "wc_notifyMessage":
          return this.onNotifyMessageResponse(topic, payload);
        case "wc_notifyDelete":
          return this.onNotifyDeleteResponse(topic, payload);
        case "wc_notifyUpdate":
          return this.onNotifyUpdateResponse(topic, payload);
        case "wc_notifyWatchSubscription":
          return this.onNotifyWatchSubscriptionsResponse(topic, payload);
        case "wc_notifyGetNotifications":
          return this.onNotifyGetNotificationsResponse(topic, payload);
        case "wc_notifyMarkNotificationsAsRead":
          return this.onNotifyMarkNotificationsAsReadResponse(topic, payload);
        default:
          return this.client.logger.info(
            `[Notify] Unsupported response method ${resMethod}`
          );
      }
    };

  // ---------- Relay Event Handlers --------------------------------- //

  protected onNotifySubscribeResponse: INotifyEngine["onNotifySubscribeResponse"] =
    async (responseTopic, response) => {
      this.client.logger.info(
        `onNotifySubscribeResponse on response topic ${responseTopic}`
      );

      if (isJsonRpcResult(response)) {
        const { id } = response;

        this.client.logger.info({
          event: "onNotifySubscribeResponse",
          id,
          topic: responseTopic,
          response,
        });

        const allSubscriptions = await this.updateSubscriptionsUsingJwt(
          response.result.responseAuth,
          "notify_subscription_response"
        );

        const claims =
          this.decodeAndValidateJwtAuth<NotifyClientTypes.SubscriptionResponseJWTClaims>(
            response.result.responseAuth,
            "notify_subscription_response"
          );

        const subscription = allSubscriptions.find(
          (sub) => `did:web:${sub.metadata.appDomain}` === claims.app
        );

        if (subscription) {
          this.client.emit("notify_subscription", {
            id: response.id,
            topic: responseTopic,
            params: {
              allSubscriptions: Object.values(
                this.client.getActiveSubscriptions({
                  account: subscription.account,
                })
              ),
              subscription,
            },
          });
        } else {
          this.client.emit("notify_subscription", {
            id: response.id,
            topic: responseTopic,
            params: {
              error: {
                code: -1,
                message: "Subscription not found",
              },
            },
          });
        }
        // Emit the NotifySubscription at client level.
        this.client.emit("notify_subscription", {
          id: response.id,
          topic: responseTopic,
          params: {},
        });
      } else if (isJsonRpcError(response)) {
        // Emit the error response at client level.
        this.client.emit("notify_subscription", {
          id: response.id,
          topic: responseTopic,
          params: {
            error: response.error,
          },
        });
      }
    };

  protected onNotifyMessageRequest: INotifyEngine["onNotifyMessageRequest"] =
    async (topic, payload) => {
      this.client.logger.info({
        event: "Engine.onNotifyMessageRequest",
        topic,
        payload,
      });

      let messageClaims: NotifyClientTypes.MessageJWTClaims;

      try {
        messageClaims =
          this.decodeAndValidateJwtAuth<NotifyClientTypes.MessageJWTClaims>(
            payload.params.messageAuth,
            "notify_message"
          );
      } catch (error: any) {
        this.client.logger.error(
          `[Notify] Engine.onNotifyMessageRequest > decoding/validating messageAuth failed > ${error.message}`
        );
        await this.sendError(payload.id, topic, error);
        return;
      }

      // To account for data races occuring from history injection of notify messages
      if (!this.client.messages.keys.some((key) => key === topic)) {
        await this.client.messages.set(topic, {
          messages: {},
          topic,
        });
      }

      const currentMessages = this.client.messages.get(topic).messages;

      const messageIdAlreadyReceived = Object.values(currentMessages).some(
        (msg) => msg.message.id === messageClaims.msg.id
      );

      if (messageIdAlreadyReceived) {
        this.client.logger.warn(
          `[Notify] Message with id ${messageClaims.msg.id} already received. Ignoring.`
        );
        return;
      }

      await this.client.messages.update(topic, {
        messages: {
          ...currentMessages,
          [payload.id]: {
            id: payload.id,
            topic,
            message: messageClaims.msg,
            // Not using publishedAt as these messages can be coming from Archive API
            // Multiplying by 1000 to get the timestamp in ms, instead of seconds
            publishedAt: messageClaims.iat * 1000,
          },
        },
      });

      try {
        const responseAuth = await this.generateMessageResponseAuth({
          topic,
        });

        this.client.logger.info(
          `[Notify] Engine.onNotifyMessageRequest > generated responseAuth JWT: ${responseAuth}`
        );

        await this.sendResult<"wc_notifyMessage">(payload.id, topic, {
          responseAuth,
        });
      } catch (error: any) {
        this.client.logger.error(
          `[Notify] Engine.onNotifyMessageRequest > generating responseAuth failed: ${error.message}`
        );
        await this.sendError(payload.id, topic, {
          code: -1,
          message: error.message || error,
        });
      }
      this.client.emit("notify_message", {
        id: payload.id,
        topic,
        params: { message: messageClaims.msg },
      });
      this.client.emit("notify_notification", {
        id: payload.id,
        topic,
        params: { notification: messageClaims.msg },
      });
    };

  protected onNotifyMessageResponse: INotifyEngine["onNotifyMessageResponse"] =
    async (topic, payload) => {
      if (isJsonRpcResult(payload)) {
        this.client.logger.info(
          "[Notify] Engine.onNotifyMessageResponse > result:",
          topic,
          payload
        );
      } else if (isJsonRpcError(payload)) {
        this.client.logger.error(
          "[Notify] Engine.onNotifyMessageResponse > error:",
          topic,
          payload.error
        );
      }
    };

  protected onNotifyDeleteResponse: INotifyEngine["onNotifyDeleteResponse"] =
    async (topic, payload) => {
      if (isJsonRpcResult(payload)) {
        this.client.logger.info(
          "[Notify] Engine.onNotifyDeleteResponse > result:",
          topic,
          payload
        );

        await this.updateSubscriptionsUsingJwt(
          payload.result.responseAuth,
          "notify_delete_response"
        );

        this.client.emit("notify_delete", {
          id: payload.id,
          topic,
          params: {},
        });
      } else if (isJsonRpcError(payload)) {
        this.client.logger.error(
          "[Notify] Engine.onNotifyDeleteResponse > error:",
          topic,
          payload.error
        );
        this.client.emit("notify_delete", {
          id: payload.id,
          topic,
          params: {
            error: payload.error,
          },
        });
      }
    };

  protected onNotifyMarkNotificationsAsReadResponse: INotifyEngine["onNotifyMarkNotificationsAsReadResponse"] =
    async (topic, payload) => {
      if (isJsonRpcResult(payload)) {
        this.client.logger.info(
          "[Notify] Engine.onNotifyGetNotificationsResponse > result:",
          topic,
          payload
        );

        // Contents of the JWT don't matter as we only care about whether or not
        // the success was successful or failed

        this.emit("notify_mark_notifications_as_read_response", {
          topic,
          error: null,
        });
      } else if (isJsonRpcError(payload)) {
        this.client.logger.error(
          "[Notify] Engine.onNotifyGetNotificationsResponse  > error:",
          topic,
          payload.error
        );

        this.emit("notify_mark_notifications_as_read_response", {
          topic,
          error: payload.error.message,
        });
      }
    };

  protected onNotifyGetNotificationsResponse: INotifyEngine["onNotifyGetNotificationsResponse"] =
    async (topic, payload) => {
      if (isJsonRpcResult(payload)) {
        this.client.logger.info(
          "[Notify] Engine.onNotifyGetNotificationsResponse > result:",
          topic,
          payload
        );
        const claims =
          this.decodeAndValidateJwtAuth<NotifyClientTypes.GetNotificationsResponseClaims>(
            payload.result.auth,
            "notify_get_notifications_response"
          );

        const mappedNotifications: NotifyClientTypes.NotifyNotification[] =
          claims.nfs.map((nf) => ({
            body: nf.body,
            id: nf.id,
            sentAt: nf.sent_at,
            title: nf.title,
            url: nf.url || null,
            type: nf.type,
            isRead: nf.is_read,
          }));

        this.emit("notify_get_notifications_response", {
          topic,
          hasMore: claims.mre ?? false,
          hasMoreUnread: claims.mur ?? false,
          error: null,
          notifications: mappedNotifications,
        });
      } else if (isJsonRpcError(payload)) {
        this.client.logger.error(
          "[Notify] Engine.onNotifyGetNotificationsResponse  > error:",
          topic,
          payload.error
        );

        this.emit("notify_get_notifications_response", {
          topic,
          error: payload.error.message,
        });
      }
    };

  protected onNotifyWatchSubscriptionsResponse: INotifyEngine["onNotifyWatchSubscriptionsResponse"] =
    async (topic, payload) => {
      this.client.logger.info(
        "onNotifyWatchSubscriptionsResponse",
        topic,
        payload
      );

      if (isJsonRpcResult(payload)) {
        const subscriptions = await this.updateSubscriptionsUsingJwt(
          payload.result.responseAuth,
          "notify_watch_subscriptions_response"
        );

        this.client.logger.info({
          event: "notify_subscriptions_changed",
          topic,
          id: payload.id,
          subscriptions,
        });

        this.finishedInitialLoad = true;

        this.client.emit("notify_subscriptions_changed", {
          id: payload.id,
          topic,
          params: {
            subscriptions,
          },
        });
      } else if (isJsonRpcError(payload)) {
        // Even if there was an error, loading is technically complete
        this.finishedInitialLoad = true;

        this.client.logger.error({
          event: "onNotifyWatchSubscriptionsResponse",
          topic,
          error: payload.error,
        });
      }
    };

  protected onNotifySubscriptionsChangedRequest: INotifyEngine["onNotifySubscriptionsChangedRequest"] =
    async (topic, payload) => {
      this.client.logger.info(
        "onNotifySubscriptionsChangedRequest",
        topic,
        payload
      );

      const subscriptions = await this.updateSubscriptionsUsingJwt(
        payload.params.subscriptionsChangedAuth,
        "notify_subscriptions_changed"
      );

      this.client.logger.info({
        event: "notify_subscriptions_changed",
        topic,
        id: payload.id,
        subscriptions,
      });

      this.client.emit("notify_subscriptions_changed", {
        id: payload.id,
        topic,
        params: {
          subscriptions,
        },
      });
    };

  protected onNotifyUpdateResponse: INotifyEngine["onNotifyUpdateResponse"] =
    async (topic, payload) => {
      if (isJsonRpcResult(payload)) {
        this.client.logger.info({
          event: "onNotifyUpdateResponse",
          topic,
          result: payload,
        });

        const allSubscriptions = await this.updateSubscriptionsUsingJwt(
          payload.result.responseAuth,
          "notify_update_response"
        );

        const claims =
          this.decodeAndValidateJwtAuth<NotifyClientTypes.UpdateResponseJWTClaims>(
            payload.result.responseAuth,
            "notify_update_response"
          );

        const subscription = allSubscriptions.find(
          (sub) => `did:web:${sub.metadata.appDomain}` === claims.app
        );

        if (subscription) {
          this.client.emit("notify_update", {
            id: payload.id,
            topic,
            params: {
              subscription,
              allSubscriptions: Object.values(
                this.client.getActiveSubscriptions({
                  account: subscription.account,
                })
              ),
            },
          });
        } else {
          this.client.events.emit("notify_update", {
            id: payload.id,
            topic,
            params: {
              error: {
                code: -1,
                message: "Subscription not found",
              },
            },
          });
        }
      } else if (isJsonRpcError(payload)) {
        this.client.logger.error({
          event: "onNotifyUpdateResponse",
          topic,
          error: payload.error,
        });
        this.client.emit("notify_update", {
          id: payload.id,
          topic,
          params: {
            error: payload.error,
          },
        });
      }
    };

  // ---------- Relay Event Forwarding ------------------------------- //

  protected on: INotifyEngine["on"] = (name, listener) => {
    return this.client.events.on(name, listener);
  };

  protected once: INotifyEngine["once"] = (name, listener) => {
    return this.client.events.once(name, listener);
  };

  protected off: INotifyEngine["off"] = (name, listener) => {
    return this.client.events.off(name, listener);
  };

  protected emit: INotifyEngine["emit"] = (name, args) => {
    return this.client.events.emit(name, args);
  };

  // ---------- Private Helpers --------------------------------- //

  private isInitialized() {
    if (!this.initialized) {
      const { message } = getInternalError("NOT_INITIALIZED", this.name);
      throw new Error(message);
    }
  }

  private async getNotifyServerWatchTopic(notifyId: string) {
    return hashKey(notifyId);
  }

  private async watchSubscriptions(
    accountId: string,
    appDomain: string,
    allApps: boolean
  ) {
    this.lastWatchSubscriptionsCallTimestamp = Date.now();

    const notifyKeys = await this.resolveKeys(this.client.notifyServerUrl);

    // Derive req topic from did.json
    const notifyServerWatchReqTopic = await this.getNotifyServerWatchTopic(
      notifyKeys.dappPublicKey
    );

    this.client.logger.info(
      "watchSubscriptions >",
      "notifyServerWatchReqTopic >",
      notifyServerWatchReqTopic
    );

    const issuedAt = Math.round(Date.now() / 1000);
    const expiry =
      issuedAt + ENGINE_RPC_OPTS["wc_notifyWatchSubscription"].res.ttl;

    let pubKeyY: string;
    let privKeyY: string;

    // Generate (or use existing) persistent key kY
    if (this.client.watchedAccounts.keys.includes(accountId)) {
      const existingWatchEntry = this.client.watchedAccounts.get(accountId);
      pubKeyY = existingWatchEntry.publicKeyY;
      privKeyY = existingWatchEntry.privateKeyY;
    } else {
      pubKeyY = await this.client.core.crypto.generateKeyPair();
      privKeyY = this.client.core.crypto.keychain.get(pubKeyY);
    }

    // Force the keychain to be in sync with watched account entry.
    await this.client.core.crypto.keychain.set(pubKeyY, privKeyY);

    // Generate res topic from persistent key kY
    const notifyServerWatchResTopic = hashKey(
      deriveSymKey(privKeyY, notifyKeys.dappPublicKey)
    );
    // Subscribe to res topic
    await this.client.core.relayer.subscriber.subscribe(
      notifyServerWatchResTopic
    );

    const claims: NotifyClientTypes.NotifyWatchSubscriptionsClaims = {
      act: "notify_watch_subscriptions",
      iss: encodeEd25519Key(
        await this.client.identityKeys.getIdentity({ account: accountId })
      ),
      exp: expiry,
      iat: issuedAt,
      aud: encodeEd25519Key(notifyKeys.dappIdentityKey),
      ksu: this.client.keyserverUrl,
      sub: composeDidPkh(accountId),
      app: allApps ? null : `did:web:${appDomain}`,
      mjv: "1",
      sdk: {
        packageManager: NOTIFY_CLIENT_PACKAGE_MANAGER,
        packages: {
          ...this.client.sdkVersionMap,
        },
      },
    };

    const generatedAuth = await this.client.identityKeys.generateIdAuth(
      accountId,
      claims
    );

    this.client.logger.info(
      "watchSubscriptions >",
      "subscriptionAuth >",
      generatedAuth
    );

    const id = await this.sendRequest(
      notifyServerWatchReqTopic,
      "wc_notifyWatchSubscription",
      {
        watchSubscriptionsAuth: generatedAuth,
      },
      {
        type: TYPE_1,
        senderPublicKey: pubKeyY,
        receiverPublicKey: notifyKeys.dappPublicKey,
      }
    );

    // Use an array to account for the slim chance of an
    // incorrect state where there is more than one account marked as
    // lastWatched.
    const currentLastWatchedAccounts = this.client.watchedAccounts
      .getAll()
      .filter((account) => account.lastWatched);

    for (const watchedAccount of currentLastWatchedAccounts) {
      await this.client.watchedAccounts.update(watchedAccount.account, {
        lastWatched: false,
      });
    }

    // Set new or overwrite existing account watch data.
    await this.client.watchedAccounts.set(accountId, {
      appDomain,
      account: accountId,
      allApps,
      lastWatched: true,
      privateKeyY: privKeyY,
      publicKeyY: pubKeyY,
      resTopic: notifyServerWatchResTopic,
    });

    this.client.logger.info("watchSubscriptions >", "requestId >", id);
  }

  private updateSubscriptionsUsingJwt = async (
    jwt: string,
    act:
      | NotifyClientTypes.NotifyWatchSubscriptionsResponseClaims["act"]
      | NotifyClientTypes.NotifySubscriptionsChangedClaims["act"]
      | NotifyClientTypes.SubscriptionResponseJWTClaims["act"]
      | NotifyClientTypes.DeleteResponseJWTClaims["act"]
      | NotifyClientTypes.UpdateResponseJWTClaims["act"]
  ) => {
    const claims = this.decodeAndValidateJwtAuth<
      | NotifyClientTypes.NotifyWatchSubscriptionsResponseClaims
      | NotifyClientTypes.NotifySubscriptionsChangedClaims
      | NotifyClientTypes.SubscriptionResponseJWTClaims
      | NotifyClientTypes.DeleteResponseJWTClaims
      | NotifyClientTypes.UpdateResponseJWTClaims
    >(jwt, act);

    this.client.logger.info("updateSubscriptionsUsingJwt > claims", claims);

    // Clean up any subscriptions that are no longer valid.
    const newStateSubsTopics = claims.sbs.map((sb) => hashKey(sb.symKey));
    for (const currentSubTopic of this.client.subscriptions
      .getAll()
      .map((sub) => sub.topic)) {
      if (!newStateSubsTopics.includes(currentSubTopic)) {
        // We only want to clean up the subscription if it was created by the current account.
        if (this.client.subscriptions.keys.includes(currentSubTopic)) {
          const existingSub = this.client.subscriptions.get(currentSubTopic);
          if (
            existingSub.account === claims.sub.split(":").slice(2).join(":")
          ) {
            this.client.logger.info(
              `[Notify] updateSubscriptionsUsingJwt > cleanupSubscription on topic ${currentSubTopic}`
            );
            await this.cleanupSubscription(currentSubTopic);
          }
        }
      }
    }

    // Update all subscriptions to account for any changes in scope.
    const updateSubscriptionsPromises = claims.sbs.map((sub) => async () => {
      const sbTopic = hashKey(sub.symKey);
      const notifyConfig = await this.resolveNotifyConfig(sub.appDomain);
      const scopeMap = notifyConfig
        ? this.generateScopeMap(notifyConfig, sub)
        : {};

      await this.client.subscriptions.set(sbTopic, {
        account: sub.account,
        expiry: sub.expiry,
        topic: sbTopic,
        scope: scopeMap,
        symKey: sub.symKey,
        appAuthenticationKey: sub.appAuthenticationKey,
        metadata: {
          name: notifyConfig?.name ?? sub.appDomain,
          description: notifyConfig?.description ?? sub.appDomain,
          icons: notifyConfig?.image_url
            ? Object.values(notifyConfig.image_url)
            : [],
          appDomain: sub.appDomain,
        },
        relay: {
          protocol: RELAYER_DEFAULT_PROTOCOL,
        },
        unreadNotificationCount: sub.unreadNotificationCount,
      });

      await this.client.core.crypto.setSymKey(sub.symKey, sbTopic);

      if (!this.client.core.relayer.subscriber.topics.includes(sbTopic)) {
        try {
          await this.client.core.relayer.subscribe(sbTopic);
        } catch (e) {
          this.client.logger.error("Failed to subscribe from claims.sbs", e);
        }
      }

      if (!this.client.messages.keys.includes(sbTopic)) {
        // Set up a store for messages sent to this notify topic.
        await this.client.messages.set(sbTopic, {
          topic: sbTopic,
          messages: {},
        });
      }
    });

    const newSubscriptions = claims.sbs.filter(
      (sb) => !this.client.subscriptions.keys.includes(hashKey(sb.symKey))
    );

    this.client.logger.info(
      "updateSubscriptionsUsingJwt > newSubscriptions",
      newSubscriptions
    );

    await Promise.allSettled(
      updateSubscriptionsPromises.map((promiseCb) => promiseCb())
    );

    return this.client.subscriptions.getAll();
  };

  private cleanupSubscription = async (topic: string) => {
    this.client.logger.info(`[Notify] cleanupSubscription > topic: ${topic}`);
    // Await the unsubscribe first to avoid deleting the symKey too early below.
    await this.client.core.relayer.unsubscribe(topic);
    await Promise.all([
      this.client.subscriptions.delete(topic, {
        code: -1,
        message: "Deleted subscription.",
      }),
      this.client.messages.delete(topic, {
        code: -1,
        message: "Deleted subscription.",
      }),
      this.client.core.crypto.deleteSymKey(topic),
    ]);
  };

  private generateSubscriptionAuth = async (
    accountId: string,
    payload: JwtPayload
  ) => {
    return this.client.identityKeys.generateIdAuth(accountId, payload);
  };

  private generateMessageResponseAuth = async ({
    topic,
  }: {
    topic: string;
  }) => {
    try {
      const subscription = this.client.subscriptions.get(topic);
      const identityKeyPub = await this.client.identityKeys.getIdentity({
        account: subscription.account,
      });

      const dappUrl = getDappUrl(subscription.metadata.appDomain);

      const cachedKey = this.getCachedDappKey(subscription);
      const { dappIdentityKey } = cachedKey
        ? { dappIdentityKey: cachedKey }
        : await this.resolveKeys(dappUrl);

      const issuedAt = Math.round(Date.now() / 1000);
      const expiry = issuedAt + ENGINE_RPC_OPTS["wc_notifyMessage"].res.ttl;
      const payload: NotifyClientTypes.MessageResponseJWTClaims = {
        act: "notify_message_response",
        iat: issuedAt,
        exp: expiry,
        iss: encodeEd25519Key(identityKeyPub),
        aud: encodeEd25519Key(dappIdentityKey),
        sub: composeDidPkh(subscription.account),
        app: `${DID_WEB_PREFIX}${subscription.metadata.appDomain}`,
        ksu: this.client.keyserverUrl,
        mjv: "1",
        sdk: {
          packageManager: NOTIFY_CLIENT_PACKAGE_MANAGER,
          packages: {
            ...this.client.sdkVersionMap,
          },
        },
      };

      const responseAuth = await this.client.identityKeys.generateIdAuth(
        subscription.account,
        payload
      );

      return responseAuth;
    } catch (error: any) {
      throw new Error(
        `generateMessageResponseAuth failed for message on topic ${topic}: ${
          error.message || error
        }`
      );
    }
  };

  private generateDeleteAuth = async ({ topic }: { topic: string }) => {
    try {
      const subscription = this.client.subscriptions.get(topic);
      const identityKeyPub = await this.client.identityKeys.getIdentity({
        account: subscription.account,
      });
      const dappUrl = getDappUrl(subscription.metadata.appDomain);

      const cachedKey = this.getCachedDappKey(subscription);
      const { dappIdentityKey } = cachedKey
        ? { dappIdentityKey: cachedKey }
        : await this.resolveKeys(dappUrl);

      const issuedAt = Math.round(Date.now() / 1000);
      const expiry = issuedAt + ENGINE_RPC_OPTS["wc_notifyDelete"].req.ttl;
      const payload: NotifyClientTypes.DeleteJWTClaims = {
        act: "notify_delete",
        iat: issuedAt,
        exp: expiry,
        iss: encodeEd25519Key(identityKeyPub),
        aud: encodeEd25519Key(dappIdentityKey),
        sub: composeDidPkh(subscription.account),
        ksu: this.client.keyserverUrl,
        app: `${DID_WEB_PREFIX}${subscription.metadata.appDomain}`,
        mjv: "1",
        sdk: {
          packageManager: NOTIFY_CLIENT_PACKAGE_MANAGER,
          packages: {
            ...this.client.sdkVersionMap,
          },
        },
      };

      const deleteAuth = await this.client.identityKeys.generateIdAuth(
        subscription.account,
        payload
      );

      return deleteAuth;
    } catch (error: any) {
      throw new Error(
        `generateDeleteAuth failed for topic ${topic}: ${
          error.message || error
        }`
      );
    }
  };

  private generateUpdateAuth = async ({
    subscription,
    scope,
  }: {
    subscription: NotifyClientTypes.NotifySubscription;
    scope: string[];
  }) => {
    try {
      const identityKeyPub = await this.client.identityKeys.getIdentity({
        account: subscription.account,
      });
      const dappUrl = getDappUrl(subscription.metadata.appDomain);

      const cachedKey = this.getCachedDappKey(subscription);
      const { dappIdentityKey } = cachedKey
        ? { dappIdentityKey: cachedKey }
        : await this.resolveKeys(dappUrl);

      const issuedAt = Math.round(Date.now() / 1000);
      const expiry = issuedAt + ENGINE_RPC_OPTS["wc_notifyUpdate"].req.ttl;
      const payload: NotifyClientTypes.UpdateJWTClaims = {
        act: "notify_update",
        iat: issuedAt,
        exp: expiry,
        iss: encodeEd25519Key(identityKeyPub),
        aud: encodeEd25519Key(dappIdentityKey),
        sub: composeDidPkh(subscription.account),
        app: `${DID_WEB_PREFIX}${subscription.metadata.appDomain}`,
        ksu: this.client.keyserverUrl,
        scp: scope.join(JWT_SCP_SEPARATOR),
        mjv: "1",
        sdk: {
          packageManager: NOTIFY_CLIENT_PACKAGE_MANAGER,
          packages: {
            ...this.client.sdkVersionMap,
          },
        },
      };

      const updateAuth = await this.client.identityKeys.generateIdAuth(
        subscription.account,
        payload
      );

      return updateAuth;
    } catch (error: any) {
      throw new Error(
        `generateUpdateAuth failed for topic ${subscription.topic}: ${
          error.message || error
        }`
      );
    }
  };

  private decodeAndValidateJwtAuth = <
    T extends NotifyClientTypes.BaseJwtClaims
  >(
    jwtAuth: string,
    expectedAct: T["act"]
  ) => {
    let messageClaims: T;

    // Attempt to decode the JWT string. Will throw `InvalidTokenError` if invalid.
    try {
      messageClaims = jwtDecode<T>(jwtAuth);
    } catch (error: unknown) {
      this.client.logger.error(
        `[Notify] Engine.onNotifyMessageRequest > Failed to decode messageAuth JWT: ${jwtAuth}`
      );
      throw new Error((error as InvalidTokenError).message);
    }

    // Validate `act` claim is as expected.
    if (messageClaims.act !== expectedAct) {
      throw new Error(
        `Invalid messageAuth JWT act claim: ${messageClaims.act}. Expected "${expectedAct}"`
      );
    }

    return messageClaims;
  };

  private registerIdentity: INotifyEngine["register"] = async ({
    signature,
    signatureType,
    registerParams,
  }) => {
    const accountId = getCaip10FromDidPkh(registerParams.cacaoPayload.iss);

    const allApps =
      registerParams.cacaoPayload.statement ===
      NOTIFY_AUTHORIZATION_STATEMENT_ALL_DOMAINS;

    if (this.client.identityKeys.isRegistered(accountId)) {
      const hasStaleStatement = this.checkIfIdentityIsStale(
        accountId,
        allApps
          ? NOTIFY_AUTHORIZATION_STATEMENT_ALL_DOMAINS
          : NOTIFY_AUTHORIZATION_STATEMENT_THIS_DOMAIN,
        registerParams.cacaoPayload.domain
      );
      if (hasStaleStatement) {
        throw new Error(
          "Failed to register, user has an existing stale identity. Unregister using the unregister method."
        );
      }
    }

    const registeredIdentity = await this.client.identityKeys.registerIdentity({
      signature: {
        s: signature,
        t: signatureType ?? "eip191",
      },
      registerParams,
    });

    const { statement, domain } = registerParams.cacaoPayload;

    if (!statement) {
      throw new Error(
        `Failed to register. Expected statement to be string, instead got: ${statement}`
      );
    }

    this.client.registrationData.set(accountId, {
      account: accountId,
      domain,
      statement,
    });

    return registeredIdentity;
  };

  // This is a separate method from `resolveKeys` and not an
  // internal caching mechanism of `resolveKeys` because it works when
  // only the `dappIdentityKey` is required, not both a dapp's keys.
  // This is because it does not cover fetching the `dappPublicKey`
  // property that `resolveKeys` can fetch.
  private getCachedDappKey = (
    subscription: NotifyClientTypes.NotifySubscription
  ) => {
    if (!subscription.appAuthenticationKey) {
      return null;
    }
    return Buffer.from(
      decodeEd25519Key(subscription.appAuthenticationKey)
    ).toString("hex");
  };

  private resolveKeys = async (
    dappUrl: string
  ): Promise<{ dappPublicKey: string; dappIdentityKey: string }> => {
    let didDoc: NotifyClientTypes.NotifyDidDocument;

    this.client.logger.debug("didDocMap: ", this.didDocMap);

    // Check if we've already fetched the dapp's DID doc.
    if (this.didDocMap.has(dappUrl)) {
      didDoc = this.didDocMap.get(dappUrl)!;
    } else {
      // If not, fetch dapp's public key from its hosted DID doc.
      try {
        const didDocResp = await axios.get(`${dappUrl}/.well-known/did.json`);
        didDoc = didDocResp.data;
        this.didDocMap.set(dappUrl, didDoc);
      } catch (error: any) {
        throw new Error(
          `Failed to fetch dapp's DID doc from ${dappUrl}/.well-known/did.json. Error: ${error.message}`
        );
      }
    }

    // Look up the required keys for keyAgreement and authentication in the didDoc.
    const keyAgreementVerificationMethod = didDoc.verificationMethod.find(
      (vm) => vm.id === didDoc.keyAgreement[0]
    );
    const authenticationVerificationMethod = didDoc.verificationMethod.find(
      (vm) => vm.id === didDoc.authentication[0]
    );

    if (!keyAgreementVerificationMethod) {
      throw new Error(
        `No keyAgreement verification method found in DID doc for ${dappUrl}`
      );
    }
    if (!authenticationVerificationMethod) {
      throw new Error(
        `No authentication verification method found in DID doc for ${dappUrl}`
      );
    }

    // Derive the dappPublicKey and dappIdentityKey from the JWKs.
    const { publicKeyJwk } = keyAgreementVerificationMethod;
    const base64Jwk = publicKeyJwk.x.replace(/-/g, "+").replace(/_/g, "/");
    const dappPublicKey = Buffer.from(base64Jwk, "base64").toString("hex");

    const { publicKeyJwk: identityKeyJwk } = authenticationVerificationMethod;
    const base64IdentityJwk = identityKeyJwk.x
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const dappIdentityKey = Buffer.from(base64IdentityJwk, "base64").toString(
      "hex"
    );

    this.client.logger.info(
      `[Notify] resolveKeys > publicKey for ${dappUrl} is: ${dappPublicKey}`
    );

    return { dappPublicKey, dappIdentityKey };
  };

  private resolveNotifyConfig = async (
    dappDomain: string
  ): Promise<NotifyClientTypes.NotifyConfigDocument | null> => {
    const dappConfigUrl = `${DEFAULT_EXPLORER_API_URL}/notify-config?projectId=${this.client.core.projectId}&appDomain=${dappDomain}`;
    try {
      // Fetch dapp's Notify config from its hosted wc-notify-config.
      const notifyConfigResp = await axios.get(dappConfigUrl);
      const notifyConfig = notifyConfigResp.data.data;

      this.client.logger.info(
        `[Notify] subscribe > got notify config: ${JSON.stringify(
          notifyConfig
        )}`
      );
      return notifyConfig;
    } catch (error: any) {
      this.client.logger.error(
        `Failed to fetch dapp's Notify config from ${dappConfigUrl}. Error: ${error.message}`
      );
      return null;
    }
  };

  private generateScopeMap = (
    dappConfig: NotifyClientTypes.NotifyConfigDocument,
    serverSub: NotifyClientTypes.NotifyServerSubscription
  ): NotifyClientTypes.ScopeMap => {
    return Object.fromEntries(
      dappConfig.notificationTypes.map((type) => {
        return [
          type.id,
          {
            imageUrls: type.imageUrls,
            description: type.description,
            name: type.name,
            id: type.id,
            enabled: serverSub.scope.includes(type.id),
          },
        ];
      })
    );
  };

  // returns true if statement is stale, false otherwise.
  private checkIfIdentityIsStale = (
    account: string,
    currentStatement: string,
    domain: string
  ) => {
    const hasSignedStatement =
      this.client.registrationData.keys.includes(account);
    if (!hasSignedStatement) {
      // if there is no signed statement, then this account's statement was signed
      // previous to this function (and thus the latest statement) being introduced
      // therefore, it is stale.
      return true;
    }

    const signedStatement = this.client.registrationData.get(account);

    const isRecapsStatement = new RegExp(
      `\'manage\'\: \'.*notifications\'`
    ).test(signedStatement.statement);

    return (
      (!isRecapsStatement && signedStatement.statement !== currentStatement) ||
      signedStatement.domain !== domain
    );
  };

  private watchLastWatchedAccountIfExists = async () => {
    // Get account that was watched
    const lastWatched = this.client.watchedAccounts
      .getAll()
      .find((acc) => acc.lastWatched);

    // If an account was previously watched
    if (lastWatched) {
      const { account, appDomain, allApps } = lastWatched;

      try {
        // Account for invalid state where the last watched account does not have an identity.
        const identity = await this.client.identityKeys.getIdentity({
          account,
        });
        if (!identity) {
          throw new Error(
            `No identity key found for lastWatchedAccount ${account}`
          );
        }
      } catch (error) {
        this.client.logger.error(
          `[Notify] Engine > watchLastWatchedAccountIfExists failed: ${error}`
        );
        return;
      }

      try {
        await this.watchSubscriptions(account, appDomain, allApps);
      } catch (error: any) {
        this.client.logger.error(
          `[Notify] Engine.watchLastWatchedAccountIfExists > Failed to watch subscriptions for account ${account} > ${error.message}`
        );
      }
    } else {
      this.finishedInitialLoad = true;
    }
  };

  private readNotifications = async ({
    topic,
    notificationIds,
    all,
  }: {
    topic: string;
    notificationIds: string[] | null;
    all: boolean;
  }): Promise<void> => {
    this.isInitialized();

    if (!this.client.subscriptions.keys.includes(topic)) {
      throw new Error(`No subscription with topic ${topic} exists`);
    }

    const subscription = this.client.subscriptions.get(topic);

    const identityKey = encodeEd25519Key(
      await this.client.identityKeys.getIdentity({
        account: subscription.account,
      })
    );

    const issuedAt = Math.round(Date.now() / 1000);
    const expiry =
      issuedAt + ENGINE_RPC_OPTS["wc_notifyMarkNotificationsAsRead"].req.ttl;

    const cachedKey = this.getCachedDappKey(subscription);
    const dappUrl = getDappUrl(subscription.metadata.appDomain);
    const { dappIdentityKey } = cachedKey
      ? { dappIdentityKey: cachedKey }
      : await this.resolveKeys(dappUrl);

    const markNotificationsAsReadClaims: NotifyClientTypes.MarkNotificationsAsReadJwtClaims =
      {
        act: "notify_mark_notifications_as_read",
        iss: identityKey,
        ksu: this.client.keyserverUrl,
        aud: encodeEd25519Key(dappIdentityKey),
        app: `${DID_WEB_PREFIX}${subscription.metadata.appDomain}`,
        all,
        ids: notificationIds,
        sub: composeDidPkh(subscription.account),
        iat: issuedAt,
        exp: expiry,
        mjv: "1",
        sdk: {
          packageManager: NOTIFY_CLIENT_PACKAGE_MANAGER,
          packages: {
            ...this.client.sdkVersionMap,
          },
        },
      };

    const auth = await this.client.identityKeys.generateIdAuth(
      subscription.account,
      markNotificationsAsReadClaims
    );

    return new Promise((resolve, reject) => {
      const listener = (
        args: NotifyEngineTypes.EventArguments["notify_mark_notifications_as_read_response"]
      ) => {
        if (args.topic !== topic) {
          return;
        }

        this.off("notify_mark_notifications_as_read_response", listener);

        if (args.error === null) {
          resolve();
        } else {
          reject(new Error(args.error));
        }
      };

      this.on("notify_mark_notifications_as_read_response", listener);

      setTimeout(() => {
        reject(
          new Error("markNotificationsAsRead timed out waiting for a response")
        );
        // Using five minutes as it is the TTL of wc_getNotificationHistory
        // The FIVE_MINUTES const is in seconds, not ms.
      }, FIVE_MINUTES * 1000);

      this.sendRequest(topic, "wc_notifyMarkNotificationsAsRead", { auth });
    });
  };
}
