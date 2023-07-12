import {
  EXPIRER_EVENTS,
  RELAYER_DEFAULT_PROTOCOL,
  RELAYER_EVENTS,
} from "@walletconnect/core";
import {
  JwtPayload,
  composeDidPkh,
  encodeEd25519Key,
  jwtExp,
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
import { ExpirerTypes, RelayerTypes } from "@walletconnect/types";
import {
  TYPE_1,
  calcExpiry,
  createExpiringPromise,
  getInternalError,
  hashKey,
  parseExpirerTarget,
} from "@walletconnect/utils";
import axios from "axios";
import jwt_decode from "jwt-decode";

import {
  ENGINE_RPC_OPTS,
  JWT_SCP_SEPARATOR,
  PUSH_REQUEST_EXPIRY,
  PUSH_SUBSCRIPTION_EXPIRY,
  SDK_ERRORS,
} from "../constants";
import {
  IDappClient,
  IPushEngine,
  IWalletClient,
  JsonRpcTypes,
  PushClientTypes,
} from "../types";

export class PushEngine extends IPushEngine {
  public name = "pushEngine";
  private initialized = false;

  constructor(client: IPushEngine["client"]) {
    super(client);
  }

  public init: IPushEngine["init"] = () => {
    if (!this.initialized) {
      this.registerRelayerEvents();
      this.registerExpirerEvents();
      this.client.core.pairing.register({
        methods: Object.keys(ENGINE_RPC_OPTS),
      });

      this.initialized = true;
    }
  };

  // ---------- Public (Dapp) ----------------------------------------- //

  public propose: IPushEngine["propose"] = async ({
    account,
    pairingTopic,
    scope,
  }) => {
    this.isInitialized();

    // SPEC: Dapp generates public key X
    const publicKey = await this.client.core.crypto.generateKeyPair();
    // SPEC: Response topic is derived from hash of public key X
    const responseTopic = hashKey(publicKey);

    // SPEC: Dapp sends push proposal on known pairing P
    const proposal = {
      publicKey,
      account,
      metadata: (this.client as IDappClient).metadata,
      scope: scope ?? [],
    };
    const id = await this.sendRequest(pairingTopic, "wc_pushPropose", proposal);

    this.client.logger.info(
      `[Push] Engine.propose > sent push subscription proposal on pairing ${pairingTopic} with id: ${id}. Request: ${JSON.stringify(
        proposal
      )}`
    );

    await this.client.proposals.set(id, {
      topic: responseTopic,
      proposal,
    });

    await (this.client as IDappClient).proposalKeys.set(responseTopic, {
      responseTopic,
      proposalKeyPub: publicKey,
    });

    // Set the expiry for the push subscription proposal.
    this.client.core.expirer.set(id, calcExpiry(PUSH_REQUEST_EXPIRY));

    // Dapp subscribes to response topic, which is the sha256 hash of public key X
    await this.client.core.relayer.subscribe(responseTopic);

    this.client.logger.info(
      `[Push] Engine.propose > subscribed to response topic ${responseTopic}`
    );

    return { id };
  };

  // ---------- Public (Wallet) --------------------------------------- //

  public enableSync: IPushEngine["enableSync"] = async ({
    account,
    onSign,
  }) => {
    const client = (this.client as IWalletClient).syncClient;
    const signature = await onSign(await client.getMessage({ account }));
    await client.register({ account, signature });

    await (this.client as IWalletClient).initSyncStores({ account, signature });
  };

  public approve: IPushEngine["approve"] = async ({ id, onSign }) => {
    this.isInitialized();

    const { proposal } = this.client.proposals.get(id);
    const dappPushConfig = await this.resolvePushConfig(proposal.metadata.url);

    this.client.logger.info(
      `[Push] Engine.approve > approving push subscription proposal with id: ${id}. Proposal: ${JSON.stringify(`
        ${proposal}
        `)}`
    );
    this.client.logger.info(
      `[Push] Engine.approve > resolved push config for proposal URL ${
        proposal.metadata.url
      }: ${JSON.stringify(dappPushConfig)}`
    );

    // Check if the dapp has requested any scopes that are not supported.
    const unsupportedScopes = proposal.scope.filter(
      (scope) => !dappPushConfig.types.map((type) => type.name).includes(scope)
    );

    if (unsupportedScopes.length > 0) {
      throw new Error(
        `[Push] approve: ${
          proposal.metadata.url
        } does not seem to support following proposed scopes: ${JSON.stringify(
          unsupportedScopes
        )}`
      );
    }

    // SPEC: Wallet sends push subscribe request to Cast/Push Server with subscriptionAuth
    const { id: subscribeId, subscriptionAuth } = await this.subscribe({
      metadata: proposal.metadata,
      account: proposal.account,
      onSign,
    });

    const pushSubscriptionEvent = (await createExpiringPromise(
      new Promise((resolve) => {
        this.client.once("push_subscription", (event) => {
          if (event.id === subscribeId) {
            resolve(event);
          }
        });
      }),
      10_000,
      "[Push] Engine.approve > Awaiting push_subscription event timed out."
    )) as PushClientTypes.BaseEventArgs<PushClientTypes.PushResponseEventArgs>;

    if (pushSubscriptionEvent.params.error) {
      throw new Error(
        `[Push] Engine.approve > failed to subscribe to push server: ${pushSubscriptionEvent.params.error}`
      );
    }

    this.client.logger.info(
      `[Push] Engine.approve > got push_subscription event for id ${subscribeId}: ${JSON.stringify(
        pushSubscriptionEvent
      )}`
    );

    // SPEC: Wallet derives response topic from sha246 hash of requester publicKey (pubKey X)
    const responseTopic = hashKey(proposal.publicKey);
    // SPEC: Wallet generates key pair Z
    const selfPublicKey = await this.client.core.crypto.generateKeyPair();

    this.client.logger.info(
      `[Push] Engine.approve > derived responseTopic: ${responseTopic}`
    );
    this.client.logger.info(
      `[Push] Engine.approve > derived publicKey Z for response: ${selfPublicKey}`
    );

    const subscriptionSymKey = this.client.core.crypto.keychain.get(
      pushSubscriptionEvent.params.subscription!.topic
    );

    // SPEC: Wallet responds with type 1 envelope on response topic with subscriptionAuth and subscription symKey
    await this.sendResult<"wc_pushPropose">(
      id,
      responseTopic,
      {
        subscriptionAuth,
        subscriptionSymKey,
      },
      {
        type: TYPE_1,
        senderPublicKey: selfPublicKey,
        receiverPublicKey: proposal.publicKey,
      }
    );

    // Clean up the original request.
    this.cleanupProposal(id);

    // Clean up the keypair used to derive a shared symKey.
    await this.client.core.crypto.deleteKeyPair(selfPublicKey);
  };

  public reject: IPushEngine["reject"] = async ({ id, reason }) => {
    this.isInitialized();

    const { topic: responseTopic } = this.client.proposals.get(id);

    // SPEC: Wallet sends error response (i.e. proposal rejection) on pairing P
    await this.sendError(id, responseTopic, {
      code: SDK_ERRORS["USER_REJECTED"].code,
      message: `${SDK_ERRORS["USER_REJECTED"].message} Reason: ${reason}.`,
    });

    this.client.logger.info(
      `[Push] Engine.reject > rejected push subscription proposal on response topic ${responseTopic}`
    );

    // Clean up the original proposal.
    this.cleanupProposal(id);
  };

  public subscribe: IPushEngine["subscribe"] = async ({
    metadata,
    account,
    onSign,
  }) => {
    this.isInitialized();

    let didDoc: PushClientTypes.PushDidDocument;

    try {
      // Fetch dapp's public key from its hosted DID doc.
      const didDocResp = await axios.get(
        `${metadata.url}/.well-known/did.json`
      );
      didDoc = didDocResp.data;
    } catch (error: any) {
      throw new Error(
        `Failed to fetch dapp's DID doc from ${metadata.url}/.well-known/did.json. Error: ${error.message}`
      );
    }

    const pushConfig = await this.resolvePushConfig(metadata.url);

    // Retrieve existing identity or register a new one for this account on this device.
    await this.registerIdentity(account, onSign);

    const { publicKeyJwk } = didDoc.verificationMethod[0];
    const base64Jwk = publicKeyJwk.x.replace(/-/g, "+").replace(/_/g, "/");
    const dappPublicKey = Buffer.from(base64Jwk, "base64").toString("hex");

    this.client.logger.info(
      `[Push] subscribe > publicKey for ${metadata.url} is: ${dappPublicKey}`
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
    const identityKeyPub = await (
      this.client as IWalletClient
    ).identityKeys.getIdentity({
      account,
    });
    const dappUrl = metadata.url;
    const issuedAt = Math.round(Date.now() / 1000);
    this.client;
    const scp = pushConfig.types
      .map((type) => type.name)
      .join(JWT_SCP_SEPARATOR);
    const payload: JwtPayload = {
      iat: issuedAt,
      exp: jwtExp(issuedAt),
      iss: encodeEd25519Key(identityKeyPub),
      sub: composeDidPkh(account),
      aud: dappUrl,
      ksu: (this.client as IWalletClient).keyserverUrl,
      scp,
      act: "push_subscription",
    };

    this.client.logger.info(
      `[Push] subscribe > generating subscriptionAuth JWT for payload: ${JSON.stringify(
        payload
      )}`
    );

    const subscriptionAuth = await this.generateSubscriptionAuth(
      account,
      payload
    );

    this.client.logger.info(
      `[Push] subscribe > generated subscriptionAuth JWT: ${subscriptionAuth}`
    );

    // SPEC: Wallet subscribes to response topic
    await this.client.core.relayer.subscribe(responseTopic);

    this.client.logger.info(
      `[Push] subscribe > subscribed to responseTopic ${responseTopic}`
    );

    this.client.logger.info(
      `[Push] subscribe > sending wc_pushSubscribe request on topic ${subscribeTopic}...`
    );

    // SPEC: Wallet sends wc_pushSubscribe request (type 1 envelope) on subscribe topic with subscriptionAuth
    const id = await this.sendRequest<"wc_pushSubscribe">(
      subscribeTopic,
      "wc_pushSubscribe",
      {
        subscriptionAuth,
      },
      {
        type: TYPE_1,
        senderPublicKey: selfPublicKey,
        receiverPublicKey: dappPublicKey,
      }
    );

    this.client.logger.info({
      action: "sendRequest",
      method: "wc_pushSubscribe",
      id,
      topic: subscribeTopic,
      subscriptionAuth,
      params: {
        type: TYPE_1,
        senderPublicKey: selfPublicKey,
        receiverPublicKey: dappPublicKey,
      },
    });

    const scopeMap = this.generateScopeMapFromConfig(pushConfig.types);

    // Store the pending subscription request.
    (this.client as IWalletClient).requests.set(id, {
      topic: responseTopic,
      request: {
        account,
        metadata,
        publicKey: selfPublicKey,
        scope: scopeMap,
      },
    });

    // Set the expiry for the push subscription request.
    this.client.core.expirer.set(id, calcExpiry(PUSH_REQUEST_EXPIRY));

    return { id, subscriptionAuth };
  };

  public update: IPushEngine["update"] = async ({ topic, scope }) => {
    this.isInitialized();

    this.client.logger.info(
      `[Push] update > updating push subscription for topic ${topic} with new scope: ${JSON.stringify(
        scope
      )}`
    );

    let subscription: PushClientTypes.PushSubscription;

    // Retrieves the known subscription for the given topic or throws if no subscription is found.
    try {
      subscription = this.client.subscriptions.get(topic);
    } catch (error) {
      throw new Error(
        `update(): No subscription found to update for the given topic: ${topic}`
      );
    }

    const identityKeyPub = await (
      this.client as IWalletClient
    ).identityKeys.getIdentity({
      account: subscription.account,
    });
    const issuedAt = Math.round(Date.now() / 1000);
    const payload: JwtPayload = {
      iat: issuedAt,
      exp: jwtExp(issuedAt),
      iss: encodeEd25519Key(identityKeyPub),
      sub: composeDidPkh(subscription.account),
      aud: subscription.metadata.url,
      ksu: (this.client as IWalletClient).keyserverUrl,
      scp: scope.join(JWT_SCP_SEPARATOR),
      act: "push_subscription",
    };

    this.client.logger.info(
      `[Push] update > generating subscriptionAuth JWT for payload: ${JSON.stringify(
        payload
      )}`
    );

    const subscriptionAuth = await this.generateSubscriptionAuth(
      subscription.account,
      payload
    );

    this.client.logger.info(
      `[Push] update > generated subscriptionAuth JWT: ${subscriptionAuth}`
    );

    const id = await this.sendRequest(topic, "wc_pushUpdate", {
      subscriptionAuth,
    });

    this.client.logger.info({
      action: "sendRequest",
      method: "wc_pushUpdate",
      id,
      topic,
      subscriptionAuth,
    });

    await (this.client as IWalletClient).requests.set(id, {
      topic,
      request: {
        account: subscription.account,
        metadata: subscription.metadata,
        publicKey: identityKeyPub,
        scope: subscription.scope,
        scopeUpdate: scope,
      },
    });

    return true;
  };

  public decryptMessage: IPushEngine["decryptMessage"] = async ({
    topic,
    encryptedMessage,
  }) => {
    this.isInitialized();

    try {
      const payload: JsonRpcPayload<
        JsonRpcTypes.RequestParams["wc_pushMessage"]
      > = await this.client.core.crypto.decode(topic, encryptedMessage);

      if (!("params" in payload)) {
        throw new Error(
          "Invalid message payload provided to `decryptMessage`: expected `params` key to be present."
        );
      }

      return payload.params;
    } catch (e) {
      this.client.logger.error("Could not decode payload", encryptedMessage);
      throw new Error("Could not decode payload");
    }
  };

  public getMessageHistory: IPushEngine["getMessageHistory"] = ({ topic }) => {
    this.isInitialized();

    return (this.client as IWalletClient).messages.get(topic).messages;
  };

  public deleteSubscription: IPushEngine["deleteSubscription"] = async ({
    topic,
  }) => {
    this.isInitialized();

    await this.sendRequest(
      topic,
      "wc_pushDelete",
      SDK_ERRORS["USER_UNSUBSCRIBED"]
    );
    await this.cleanupSubscription(topic);

    this.client.logger.info(
      `[Push] Engine.delete > deleted push subscription on topic ${topic}`
    );
  };

  public deletePushMessage: IPushEngine["deletePushMessage"] = ({ id }) => {
    this.isInitialized();

    const targetRecord = (this.client as IWalletClient).messages
      .getAll()
      .find((record) => record.messages[id]);

    if (!targetRecord) {
      throw new Error(
        `No message with id ${id} found in push message history.`
      );
    }

    delete targetRecord.messages[id];

    (this.client as IWalletClient).messages.update(
      targetRecord.topic,
      targetRecord
    );
  };

  // ---------- Public (Common) --------------------------------------- //

  public getActiveSubscriptions: IPushEngine["getActiveSubscriptions"] = (
    params
  ) => {
    this.isInitialized();

    const subscriptions = this.client.subscriptions
      .getAll(params)
      .map((subscription) => [subscription.topic, subscription]);

    return Object.fromEntries(subscriptions);
  };

  // ---------- Protected Helpers --------------------------------------- //

  protected setExpiry: IPushEngine["setExpiry"] = async (topic, expiry) => {
    if (this.client.core.pairing.pairings.keys.includes(topic)) {
      await this.client.core.pairing.updateExpiry({ topic, expiry });
    }
    this.client.core.expirer.set(topic, expiry);
  };

  protected sendRequest: IPushEngine["sendRequest"] = async (
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
    this.client.core.relayer.publish(topic, message, rpcOpts);

    return payload.id;
  };

  protected sendResult: IPushEngine["sendResult"] = async (
    id,
    topic,
    result,
    encodeOpts
  ) => {
    const payload = formatJsonRpcResult(id, result);
    const message = await this.client.core.crypto.encode(
      topic,
      payload,
      encodeOpts
    );
    const record = await this.client.core.history.get(topic, id);
    const rpcOpts = ENGINE_RPC_OPTS[record.request.method].res;

    this.client.core.relayer.publish(topic, message, rpcOpts);
    await this.client.core.history.resolve(payload);

    return payload.id;
  };

  protected sendError: IPushEngine["sendError"] = async (
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

    return payload.id;
  };

  // ---------- Relay Events Router ----------------------------------- //

  private registerRelayerEvents() {
    this.client.core.relayer.on(
      RELAYER_EVENTS.message,
      async (event: RelayerTypes.MessageEvent) => {
        const { topic, message, publishedAt } = event;

        if (!message || message.length === 0) {
          return;
        }

        const isType1Payload =
          this.client.core.crypto.getPayloadType(message) === TYPE_1;

        let receiverPublicKey: string | undefined;

        // TODO: factor out the need for `proposalKeys` entirely.
        if (
          this.client instanceof IDappClient &&
          this.client.proposalKeys.keys.includes(topic)
        ) {
          try {
            const { proposalKeyPub } = this.client.proposalKeys.get(topic);
            receiverPublicKey = proposalKeyPub;
          } catch (error) {
            this.client.logger.error(
              `[Push] Engine > on RELAYER_EVENTS.message > Failed to get proposalKey for topic ${topic}: ${error}`
            );
          }
        }

        if (isType1Payload && !receiverPublicKey) {
          this.client.logger.debug(
            `[Push] Engine > on RELAYER_EVENTS.message > Skipping message on topic ${topic}, no receiverPublicKey found.`
          );
          return;
        }

        let payload: JsonRpcPayload<any, any> | void = undefined;

        payload = await this.client.core.crypto
          .decode(topic, message, {
            receiverPublicKey,
          })
          .catch((r) => {
            this.client.logger.warn(
              `Incoming message can not be handled by push client, maybe it's a sync client message? ${r}`
            );
            console.log("FAILED", {
              isType1Payload,
              message,
              receiverPublicKey,
            });
          })
          .then((v) => {
            return v;
          });

        if (!payload) return;

        // Extract the encoded `senderPublicKey` if it's a TYPE_1 message.
        const senderPublicKey = isType1Payload
          ? this.client.core.crypto.getPayloadSenderPublicKey(message)
          : undefined;

        if (isJsonRpcRequest(payload)) {
          this.client.core.history.set(topic, payload);
          this.onRelayEventRequest({
            topic,
            payload,
            publishedAt,
            senderPublicKey,
          });
        } else if (isJsonRpcResponse(payload)) {
          await this.client.core.history.resolve(payload);
          this.onRelayEventResponse({
            topic,
            payload,
            publishedAt,
            senderPublicKey,
          });
        }
      }
    );
  }

  protected onRelayEventRequest: IPushEngine["onRelayEventRequest"] = (
    event
  ) => {
    const { topic, payload, publishedAt } = event;
    const reqMethod = payload.method as JsonRpcTypes.WcMethod;

    switch (reqMethod) {
      case "wc_pushPropose":
        return this.onPushProposeRequest(topic, payload);
      case "wc_pushMessage":
        // `wc_pushMessage` requests being broadcast to all subscribers
        // by Cast server should only be handled by the wallet client.
        return this.client instanceof IWalletClient
          ? this.onPushMessageRequest(topic, payload, publishedAt)
          : null;
      case "wc_pushDelete":
        return this.onPushDeleteRequest(topic, payload);
      default:
        return this.client.logger.info(
          `[Push] Unsupported request method ${reqMethod}`
        );
    }
  };

  protected onRelayEventResponse: IPushEngine["onRelayEventResponse"] = async (
    event
  ) => {
    const { topic, payload, senderPublicKey } = event;
    const record = await this.client.core.history.get(topic, payload.id);
    const resMethod = record.request.method as JsonRpcTypes.WcMethod;

    switch (resMethod) {
      case "wc_pushPropose":
        return this.onPushProposeResponse(topic, payload, senderPublicKey);
      case "wc_pushSubscribe":
        return this.onPushSubscribeResponse(topic, payload);
      case "wc_pushMessage":
        return this.onPushMessageResponse(topic, payload);
      case "wc_pushDelete":
        return;
      case "wc_pushUpdate":
        return this.onPushUpdateResponse(topic, payload);
      default:
        return this.client.logger.info(
          `[Push] Unsupported response method ${resMethod}`
        );
    }
  };

  // ---------- Relay Event Handlers --------------------------------- //

  protected onPushProposeRequest: IPushEngine["onPushProposeRequest"] = async (
    topic,
    payload
  ) => {
    this.client.logger.info({
      event: "onPushProposeRequest",
      topic,
      payload,
    });

    const existingSubscriptions = this.client.subscriptions
      .getAll()
      .filter((sub) => sub.metadata.url === payload.params.metadata.url);

    if (existingSubscriptions.length) {
      await this.sendError(
        payload.id,
        topic,
        SDK_ERRORS.USER_HAS_EXISTING_SUBSCRIPTION
      );
      this.client.logger.error(
        SDK_ERRORS.USER_HAS_EXISTING_SUBSCRIPTION.message
      );
      return;
    }

    try {
      // Store the push subscription proposal so we can reference later for a response.
      await this.client.proposals.set(payload.id, {
        topic,
        proposal: payload.params,
      });

      // Set the expiry for the push subscription proposal.
      this.client.core.expirer.set(payload.id, calcExpiry(PUSH_REQUEST_EXPIRY));

      this.client.emit("push_proposal", {
        id: payload.id,
        topic,
        params: {
          id: payload.id,
          account: payload.params.account,
          metadata: payload.params.metadata,
        },
      });
    } catch (err: any) {
      await this.sendError(payload.id, topic, err);
      this.client.logger.error(err);
    }
  };

  protected onPushProposeResponse: IPushEngine["onPushProposeResponse"] =
    async (topic, response, senderPublicKey) => {
      this.client.logger.info({
        event: "onPushProposeResponse",
        topic,
        response,
        senderPublicKey,
      });

      if (isJsonRpcResult(response)) {
        const { id, result } = response;

        const { proposal } = this.client.proposals.get(id);
        const selfPublicKey = proposal.publicKey;
        const dappPushConfig = await this.resolvePushConfig(
          proposal.metadata.url
        );

        if (typeof result.subscriptionAuth !== "string") {
          throw new Error(
            `[Push] Engine.onPushProposeResponse > subscriptionAuth: expected string, got ${result.subscriptionAuth}`
          );
        }

        const decodedPayload = jwt_decode(
          result.subscriptionAuth
        ) as JwtPayload;

        if (!decodedPayload) {
          throw new Error(
            "[Push] Engine.onPushProposeResponse > Empty `subscriptionAuth` payload"
          );
        }

        this.client.logger.info(
          `[Push] Engine.onPushProposeResponse > decoded subscriptionAuth payload: ${JSON.stringify(
            decodedPayload
          )}`
        );

        if (!senderPublicKey) {
          throw new Error(
            "[Push] Engine.onPushProposeResponse > Missing `senderPublicKey`, cannot derive shared key."
          );
        }

        // SPEC: Dapp receives the response and derives a subscription topic from sha256 hash of subscription symKey
        const pushTopic = await this.client.core.crypto.setSymKey(
          result.subscriptionSymKey
        );

        this.client.logger.info(
          `[Push] Engine.onPushProposeResponse > derived pushTopic ${pushTopic} from response.subscriptionSymKey: ${result.subscriptionSymKey}`
        );

        const pushSubscription = {
          topic: pushTopic,
          account: proposal.account,
          relay: { protocol: RELAYER_DEFAULT_PROTOCOL },
          metadata: proposal.metadata,
          scope: this.generateScopeMapFromConfig(
            dappPushConfig.types,
            proposal.scope
          ),
          expiry: calcExpiry(PUSH_SUBSCRIPTION_EXPIRY),
          symKey: result.subscriptionSymKey,
        };

        // Store the new PushSubscription.
        await this.client.subscriptions.set(pushTopic, pushSubscription);

        // Clean up the keypair used to derive a shared symKey.
        await this.client.core.crypto.deleteKeyPair(selfPublicKey);

        // Clean up the proposal key.
        await (this.client as IDappClient).proposalKeys.delete(topic, {
          code: -1,
          message: "Proposal key deleted.",
        });

        // DappClient subscribes to pushTopic.
        await this.client.core.relayer.subscribe(pushTopic);

        // Emit the PushSubscription at client level.
        this.client.emit("push_response", {
          id: response.id,
          topic,
          params: {
            subscription: pushSubscription,
          },
        });
      } else if (isJsonRpcError(response)) {
        // Emit the error response at client level.
        this.client.emit("push_response", {
          id: response.id,
          topic,
          params: {
            error: response.error,
          },
        });
      }

      // Clean up the original request regardless of concrete result.
      this.cleanupProposal(response.id);
    };

  protected onPushSubscribeResponse: IPushEngine["onPushSubscribeResponse"] =
    async (responseTopic, response) => {
      this.client.logger.info(
        `onPushSubscribeResponse on response topic ${responseTopic}`
      );

      if (isJsonRpcResult(response)) {
        const { id } = response;

        this.client.logger.info({
          event: "onPushSubscribeResponse",
          id,
          topic: responseTopic,
          response,
        });

        const { request } = (this.client as IWalletClient).requests.get(id);

        // SPEC: Wallet derives symmetric key P with keys Y and Z.
        // SPEC: Push topic is derived from the sha256 hash of the symmetric key P
        const pushTopic = await this.client.core.crypto.generateSharedKey(
          request.publicKey,
          response.result.publicKey
        );

        this.client.logger.info(
          `onPushSubscribeResponse > derived pushTopic ${pushTopic} from selfPublicKey ${request.publicKey} and Cast publicKey ${response.result.publicKey}`
        );

        const pushSubscription = {
          topic: pushTopic,
          account: request.account,
          relay: { protocol: RELAYER_DEFAULT_PROTOCOL },
          metadata: request.metadata,
          scope: request.scope,
          expiry: calcExpiry(PUSH_SUBSCRIPTION_EXPIRY),
          symKey: this.client.core.crypto.keychain.get(pushTopic),
        };

        // Store the new PushSubscription.
        await this.client.subscriptions.set(pushTopic, pushSubscription);

        // Set up a store for messages sent to this push topic.
        await (this.client as IWalletClient).messages.set(pushTopic, {
          topic: pushTopic,
          messages: {},
        });

        // SPEC: Wallet subscribes to derived pushTopic.
        await this.client.core.relayer.subscribe(pushTopic);

        // Wallet unsubscribes from response topic.
        await this.client.core.relayer.unsubscribe(responseTopic);

        // Emit the PushSubscription at client level.
        this.client.emit("push_subscription", {
          id: response.id,
          topic: pushTopic,
          params: {
            subscription: pushSubscription,
          },
        });
      } else if (isJsonRpcError(response)) {
        // Emit the error response at client level.
        this.client.emit("push_subscription", {
          id: response.id,
          topic: responseTopic,
          params: {
            error: response.error,
          },
        });
      }

      // Clean up the original request regardless of concrete result.
      this.cleanupRequest(response.id);
    };

  protected onPushMessageRequest: IPushEngine["onPushMessageRequest"] = async (
    topic,
    payload,
    publishedAt
  ) => {
    this.client.logger.info(
      "[Push] Engine.onPushMessageRequest",
      topic,
      payload
    );

    const currentMessages = (this.client as IWalletClient).messages.get(
      topic
    ).messages;
    await (this.client as IWalletClient).messages.update(topic, {
      messages: {
        ...currentMessages,
        [payload.id]: {
          id: payload.id,
          topic,
          message: payload.params,
          publishedAt,
        },
      },
    });
    await this.sendResult<"wc_pushMessage">(payload.id, topic, true);
    this.client.emit("push_message", {
      id: payload.id,
      topic,
      params: { message: payload.params },
    });
  };

  protected onPushMessageResponse: IPushEngine["onPushMessageResponse"] =
    async (topic, payload) => {
      if (isJsonRpcResult(payload)) {
        this.client.logger.info(
          "[Push] Engine.onPushMessageResponse > result:",
          topic,
          payload
        );
      } else if (isJsonRpcError(payload)) {
        this.client.logger.error(
          "[Push] Engine.onPushMessageResponse > error:",
          topic,
          payload.error
        );
      }
    };

  protected onPushDeleteRequest: IPushEngine["onPushDeleteRequest"] = async (
    topic,
    payload
  ) => {
    const { id } = payload;
    this.client.logger.info(
      "[Push] Engine.onPushDeleteRequest",
      topic,
      payload
    );
    try {
      await this.sendResult<"wc_pushDelete">(id, topic, true);
      await this.cleanupSubscription(topic);
      this.client.events.emit("push_delete", { id, topic });
    } catch (err: any) {
      this.client.logger.error(err);
      await this.sendError(id, topic, err);
    }
  };

  protected onPushUpdateResponse: IPushEngine["onPushUpdateResponse"] = async (
    topic,
    payload
  ) => {
    if (isJsonRpcResult(payload)) {
      this.client.logger.info({
        event: "onPushUpdateResponse",
        topic,
        result: payload,
      });

      const { id } = payload;

      const { request } = (this.client as IWalletClient).requests.get(id);
      const existingSubscription = this.client.subscriptions.get(topic);

      if (!request.scopeUpdate) {
        throw new Error(
          `No scope update found in request for push update: ${JSON.stringify(
            request
          )}`
        );
      }

      const updatedScope = Object.entries(existingSubscription.scope).reduce(
        (map, [scope, setting]) => {
          map[scope] = setting;
          if (request.scopeUpdate?.includes(scope)) {
            map[scope].enabled = true;
          } else {
            map[scope].enabled = false;
          }
          return map;
        },
        {} as PushClientTypes.PushSubscription["scope"]
      );

      const updatedSubscription: PushClientTypes.PushSubscription = {
        ...existingSubscription,
        scope: updatedScope,
        expiry: calcExpiry(PUSH_SUBSCRIPTION_EXPIRY),
      };

      await this.client.subscriptions.set(topic, updatedSubscription);

      this.client.events.emit("push_update", {
        id,
        topic,
        params: {
          subscription: updatedSubscription,
        },
      });
    } else if (isJsonRpcError(payload)) {
      this.client.logger.error({
        event: "onPushUpdateResponse",
        topic,
        error: payload.error,
      });
      this.client.emit("push_update", {
        id: payload.id,
        topic,
        params: {
          error: payload.error,
        },
      });
    }
  };

  // ---------- Expirer Events ---------------------------------------- //

  private registerExpirerEvents() {
    this.client.core.expirer.on(
      EXPIRER_EVENTS.expired,
      async (event: ExpirerTypes.Expiration) => {
        this.client.logger.info(
          `[Push] EXPIRER_EVENTS.expired > target: ${event.target}, expiry: ${event.expiry}`
        );

        const { id } = parseExpirerTarget(event.target);

        if (id) {
          this.client.proposals.keys.includes(id)
            ? await this.cleanupProposal(id, true)
            : await this.cleanupRequest(id, true);
          this.client.events.emit("request_expire", { id });
        }
      }
    );
  }

  // ---------- Private Helpers --------------------------------- //

  private isInitialized() {
    if (!this.initialized) {
      const { message } = getInternalError("NOT_INITIALIZED", this.name);
      throw new Error(message);
    }
  }

  private cleanupRequest = async (id: number, expirerHasDeleted?: boolean) => {
    await Promise.all([
      (this.client as IWalletClient).requests.delete(id, {
        code: -1,
        message: "Request deleted.",
      }),
      expirerHasDeleted ? Promise.resolve() : this.client.core.expirer.del(id),
    ]);
  };

  private cleanupProposal = async (id: number, expirerHasDeleted?: boolean) => {
    await Promise.all([
      this.client.proposals.delete(id, {
        code: -1,
        message: "Proposal deleted.",
      }),
      expirerHasDeleted ? Promise.resolve() : this.client.core.expirer.del(id),
    ]);
  };

  private cleanupSubscription = async (topic: string) => {
    // Await the unsubscribe first to avoid deleting the symKey too early below.
    await this.client.core.relayer.unsubscribe(topic);
    await Promise.all([
      this.client.subscriptions.delete(topic, {
        code: -1,
        message: "Deleted subscription.",
      }),
      this.client instanceof IWalletClient
        ? this.client.messages.delete(topic, {
            code: -1,
            message: "Deleted subscription.",
          })
        : Promise.resolve(),
      this.client.core.crypto.deleteSymKey(topic),
    ]);
  };

  private generateSubscriptionAuth = async (
    accountId: string,
    payload: JwtPayload
  ) => {
    return (this.client as IWalletClient).identityKeys.generateIdAuth(
      accountId,
      payload
    );
  };

  private registerIdentity = async (
    accountId: string,
    onSign: (message: string) => Promise<string>
  ): Promise<string> => {
    return (this.client as IWalletClient).identityKeys.registerIdentity({
      accountId,
      onSign,
    });
  };

  private resolvePushConfig = async (
    dappUrl: string
  ): Promise<PushClientTypes.PushConfigDocument> => {
    try {
      // Fetch dapp's Push config from its hosted wc-push-config.
      const pushConfigResp = await axios.get(
        `${dappUrl}/.well-known/wc-push-config.json`
      );
      const pushConfig = pushConfigResp.data;

      this.client.logger.info(
        `[Push] subscribe > got push config: ${JSON.stringify(pushConfig)}`
      );
      return pushConfig;
    } catch (error: any) {
      throw new Error(
        `Failed to fetch dapp's Push config from ${dappUrl}/.well-known/wc-push-config.json. Error: ${error.message}`
      );
    }
  };

  private generateScopeMapFromConfig = (
    typesConfig: PushClientTypes.PushConfigDocument["types"],
    selected?: string[]
  ): PushClientTypes.ScopeMap => {
    return typesConfig.reduce((map, type) => {
      map[type.name] = {
        description: type.description,
        enabled: selected?.includes(type.name) ?? true,
      };
      return map;
    }, {});
  };
}
