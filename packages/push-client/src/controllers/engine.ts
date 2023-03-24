import {
  RELAYER_EVENTS,
  RELAYER_DEFAULT_PROTOCOL,
  EXPIRER_EVENTS,
} from "@walletconnect/core";
import {
  formatJsonRpcRequest,
  formatJsonRpcResult,
  formatJsonRpcError,
  isJsonRpcRequest,
  isJsonRpcResponse,
  isJsonRpcResult,
  isJsonRpcError,
  JsonRpcPayload,
} from "@walletconnect/jsonrpc-utils";
import { ExpirerTypes, RelayerTypes } from "@walletconnect/types";
import {
  calcExpiry,
  generateRandomBytes32,
  getInternalError,
  parseExpirerTarget,
} from "@walletconnect/utils";
import {
  composeDidPkh,
  encodeEd25519Key,
  generateJWT,
  jwtExp,
  JwtPayload,
} from "@walletconnect/did-jwt";
import { Cacao, formatMessage } from "@walletconnect/cacao";
import * as ed25519 from "@noble/ed25519";

import {
  DEFAULT_RELAY_SERVER_URL,
  ENGINE_RPC_OPTS,
  PUSH_REQUEST_EXPIRY,
  SDK_ERRORS,
} from "../constants";
import {
  IDappClient,
  IPushEngine,
  IWalletClient,
  JsonRpcTypes,
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

  public request: IPushEngine["request"] = async ({
    account,
    pairingTopic,
  }) => {
    this.isInitialized();

    // SPEC: Dapp generates public key X
    const publicKey = await this.client.core.crypto.generateKeyPair();
    const responseTopic = hashKey(publicKey);

    // SPEC: Dapp sends push proposal on known pairing P
    const request = {
      publicKey,
      account,
      metadata: (this.client as IDappClient).metadata,
    };
    const id = await this.sendRequest(pairingTopic, "wc_pushRequest", request);

    this.client.logger.info(
      `[Push] Engine.request > sent push subscription request on pairing ${pairingTopic} with id: ${id}. Request: ${JSON.stringify(
        request
      )}`
    );

    // Store the push subscription request so we can later reference `publicKey` when we get a response.
    await this.client.requests.set(id, {
      topic: pairingTopic,
      request,
    });

    // Set the expiry for the push subscription request.
    this.client.core.expirer.set(id, calcExpiry(PUSH_REQUEST_EXPIRY));

    // SPEC: Dapp subscribes to response topic, which is the sha256 hash of public key X
    await this.client.core.relayer.subscribe(responseTopic);

    this.client.logger.info(
      `[Push] Engine.request > subscribed to response topic ${responseTopic}`
    );

    return { id };
  };

  public notify: IPushEngine["notify"] = async ({ topic, message }) => {
    this.isInitialized();

    this.client.logger.info(
      `[Push] Engine.notify > sending push notification on pairing ${topic} with message: "${message}"`
    );

    await this.sendRequest(topic, "wc_pushMessage", message);
  };

  // ---------- Public (Wallet) --------------------------------------- //

  public approve: IPushEngine["approve"] = async ({ id, onSign }) => {
    this.isInitialized();

    const { topic: pairingTopic, request } = this.client.requests.get(id);

    // Retrieve existing identity or register a new one for this account on this device.
    await this.registerIdentity(request.account, onSign);

    const subscriptionAuth = await this.generateSubscriptionAuth(
      request.account,
      request.metadata.url
    );

    this.client.logger.debug(
      `[Push] Engine.approve > generated subscriptionAuth: ${subscriptionAuth}`
    );

    // SPEC: Wallet generates key pair Y
    const selfPublicKey = await this.client.core.crypto.generateKeyPair();

    this.client.logger.info(
      `[Push] Engine.approve > generating shared key from selfPublicKey ${selfPublicKey} and proposer publicKey ${request.publicKey}`
    );

    // SPEC: Wallet derives symmetric key from keys X and Y.
    // SPEC: Push topic is derived from sha256 hash of symmetric key.
    // `crypto.generateSharedKey` returns the sha256 hash of the symmetric key, i.e. the push topic.
    const pushTopic = await this.client.core.crypto.generateSharedKey(
      selfPublicKey,
      request.publicKey
    );

    this.client.logger.info(
      `[Push] Engine.approve > derived pushTopic: ${pushTopic}`
    );

    // SPEC: Wallet subscribes to push topic
    await this.client.core.relayer.subscribe(pushTopic);

    // SPEC: Wallet sends proposal response on pairing P with publicKey Y
    await this.sendResult<"wc_pushRequest">(id, pairingTopic, {
      publicKey: selfPublicKey,
    });

    // Store the new PushSubscription.
    await this.client.subscriptions.set(pushTopic, {
      topic: pushTopic,
      account: request.account,
      relay: { protocol: RELAYER_DEFAULT_PROTOCOL },
      metadata: request.metadata,
    });

    // Set up a store for messages sent to this push topic.
    await (this.client as IWalletClient).messages.set(pushTopic, {
      topic: pushTopic,
      messages: {},
    });

    // Clean up the original request.
    this.cleanupRequest(id);

    // Clean up the keypair used to derive a shared symKey.
    await this.client.core.crypto.deleteKeyPair(selfPublicKey);
  };

  public reject: IPushEngine["reject"] = async ({ id, reason }) => {
    this.isInitialized();

    const { topic: pairingTopic } = this.client.requests.get(id);

    // SPEC: Wallet sends error response (i.e. proposal rejection) on pairing P
    await this.sendError(id, pairingTopic, {
      code: SDK_ERRORS["USER_REJECTED"].code,
      message: `${SDK_ERRORS["USER_REJECTED"].message} Reason: ${reason}.`,
    });

    this.client.logger.info(
      `[Push] Engine.reject > rejected push subscription request on pairing topic ${pairingTopic}`
    );

    // Clean up the original request.
    this.cleanupRequest(id);
  };

  public decryptMessage: IPushEngine["decryptMessage"] = async ({
    topic,
    encryptedMessage,
  }) => {
    this.isInitialized();

    const payload: JsonRpcPayload<
      JsonRpcTypes.RequestParams["wc_pushMessage"]
    > = await this.client.core.crypto.decode(topic, encryptedMessage);

    if (!("params" in payload)) {
      throw new Error(
        "Invalid message payload provided to `decryptMessage`: expected `params` key to be present."
      );
    }

    return payload.params;
  };

  public getMessageHistory: IPushEngine["getMessageHistory"] = ({ topic }) => {
    this.isInitialized();

    return (this.client as IWalletClient).messages.get(topic).messages;
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

  public getActiveSubscriptions: IPushEngine["getActiveSubscriptions"] = () => {
    this.isInitialized();

    return Object.fromEntries(this.client.subscriptions.map);
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
    await this.client.core.relayer.publish(topic, message, rpcOpts);

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

    await this.client.core.relayer.publish(topic, message, rpcOpts);
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
        const payload = await this.client.core.crypto.decode(topic, message);

        if (isJsonRpcRequest(payload)) {
          this.client.core.history.set(topic, payload);
          this.onRelayEventRequest({ topic, payload, publishedAt });
        } else if (isJsonRpcResponse(payload)) {
          await this.client.core.history.resolve(payload);
          this.onRelayEventResponse({ topic, payload, publishedAt });
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
      case "wc_pushRequest":
        return this.onPushRequest(topic, payload);
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
    const { topic, payload } = event;
    const record = await this.client.core.history.get(topic, payload.id);
    const resMethod = record.request.method as JsonRpcTypes.WcMethod;

    switch (resMethod) {
      case "wc_pushRequest":
        return this.onPushResponse(topic, payload);
      case "wc_pushMessage":
        return this.onPushMessageResponse(topic, payload);
      case "wc_pushDelete":
        return;
      default:
        return this.client.logger.info(
          `[Push] Unsupported response method ${resMethod}`
        );
    }
  };

  // ---------- Relay Event Handlers --------------------------------- //

  protected onPushRequest: IPushEngine["onPushRequest"] = async (
    topic,
    payload
  ) => {
    this.client.logger.info("onPushRequest:", topic, payload);

    try {
      // Store the push subscription request so we can reference later for a response.
      await this.client.requests.set(payload.id, {
        topic,
        request: payload.params,
      });

      // Set the expiry for the push subscription request.
      this.client.core.expirer.set(payload.id, calcExpiry(PUSH_REQUEST_EXPIRY));

      this.client.emit("push_request", {
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

  protected onPushResponse: IPushEngine["onPushResponse"] = async (
    topic,
    response
  ) => {
    this.client.logger.info("onPushResponse", topic, response);

    if (isJsonRpcResult(response)) {
      const { id, result } = response;

      const { request } = this.client.requests.get(id);
      const selfPublicKey = request.publicKey;

      this.client.logger.info(
        `[Push] Engine.onPushResponse > generating shared key from selfPublicKey ${selfPublicKey} and responder publicKey ${result.publicKey}`
      );

      // SPEC: Wallet derives symmetric key from keys X and Y.
      // SPEC: Push topic is derived from sha256 hash of symmetric key.
      // `crypto.generateSharedKey` returns the sha256 hash of the symmetric key, i.e. the push topic.
      const pushTopic = await this.client.core.crypto.generateSharedKey(
        selfPublicKey,
        result.publicKey
      );
      const symKey = this.client.core.crypto.keychain.get(pushTopic);

      this.client.logger.info(
        `[Push] Engine.onPushResponse > derived pushTopic ${pushTopic} from symKey: ${symKey}`
      );

      await this.registerOnCastServer(request.account, symKey);

      // DappClient subscribes to pushTopic.
      await this.client.core.relayer.subscribe(pushTopic);

      const pushSubscription = {
        topic: pushTopic,
        account: request.account,
        relay: { protocol: RELAYER_DEFAULT_PROTOCOL },
        metadata: request.metadata,
      };

      // Store the new PushSubscription.
      await this.client.subscriptions.set(pushTopic, pushSubscription);

      // Clean up the keypair used to derive a shared symKey.
      await this.client.core.crypto.deleteKeyPair(selfPublicKey);

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
    try {
      await this.sendResult<"wc_pushDelete">(id, topic, true);
      await this.cleanupSubscription(topic);
      this.client.events.emit("push_delete", { id, topic });
    } catch (err: any) {
      await this.sendError(id, topic, err);
      this.client.logger.error(err);
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
          await this.cleanupRequest(id, true);
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
      this.client.requests.delete(id, {
        code: -1,
        message: "Request deleted.",
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

  private registerOnCastServer = async (account: string, symKey: string) => {
    const castUrl = (this.client as IDappClient).castUrl;
    const reqUrl = castUrl + `/${this.client.core.projectId}/register`;
    const relayUrl = this.client.core.relayUrl || DEFAULT_RELAY_SERVER_URL;
    const bodyString = JSON.stringify({
      account,
      symKey,
      relayUrl,
    });
    try {
      this.client.logger.info(
        `[Push] Engine.onPushResponse > POST to Cast Server at ${reqUrl} with body ${bodyString}`
      );

      const res = await fetch(reqUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: bodyString,
      });

      this.client.logger.info(
        `[Push] Engine.onPushResponse > POST to Cast Server at ${reqUrl} returned ${res.status} - ${res.statusText}`
      );
    } catch (error: any) {
      this.client.logger.error(
        `[Push] Could not register push subscription on Cast Server via POST with body: ${bodyString} to ${reqUrl}: ${error.message}`
      );
    }
  };

  private generateIdentityKey = async () => {
    const privateKey = ed25519.utils.randomPrivateKey();
    const publicKey = await ed25519.getPublicKey(privateKey);
    const pubKeyHex = ed25519.utils.bytesToHex(publicKey).toLowerCase();
    const privKeyHex = ed25519.utils.bytesToHex(privateKey).toLowerCase();

    this.client.core.crypto.keychain.set(pubKeyHex, privKeyHex);

    return [pubKeyHex, privKeyHex];
  };

  private generateSubscriptionAuth = (accountId: string, dappUrl: string) => {
    const { identityKeyPub, identityKeyPriv } = (
      this.client as IWalletClient
    ).identityKeys.get(accountId);

    const issuedAt = Math.round(Date.now() / 1000);
    const payload: JwtPayload = {
      iat: issuedAt,
      exp: jwtExp(issuedAt),
      iss: encodeEd25519Key(identityKeyPub),
      sub: composeDidPkh(accountId),
      aud: dappUrl,
      ksu: (this.client as IWalletClient).keyserverUrl,
    };

    this.client.logger.info(
      `[Push] Engine.generateSubscriptionAuth > Generated subscriptionAuth JWT payload: ${JSON.stringify(
        payload
      )}`
    );

    return generateJWT([identityKeyPub, identityKeyPriv], payload);
  };

  private registerIdentity = async (
    accountId: string,
    onSign: (message: string) => Promise<string>
  ): Promise<string> => {
    try {
      const storedKeyPair = (this.client as IWalletClient).identityKeys.get(
        accountId
      );
      this.client.logger.info(
        `[Push] Engine.registerIdentity > Found stored identityKey for ${accountId}: ${storedKeyPair.identityKeyPub}`
      );
      return storedKeyPair.identityKeyPub;
    } catch {
      const keyserverUrl = (this.client as IWalletClient).keyserverUrl;
      const [pubKeyHex, privKeyHex] = await this.generateIdentityKey();
      const didKey = encodeEd25519Key(pubKeyHex);

      const cacao: Cacao = {
        h: {
          t: "eip4361",
        },
        p: {
          aud: keyserverUrl,
          domain: keyserverUrl,
          iss: composeDidPkh(accountId),
          nonce: generateRandomBytes32(),
          iat: new Date().toISOString(),
          version: "1",
          resources: [didKey],
        },
        s: {
          t: "eip191",
          s: "",
        },
      };

      const cacaoMessage = formatMessage(cacao.p, composeDidPkh(accountId));

      this.client.logger.info(
        `[Push] Engine.registerIdentity > Awaiting signature for cacao: ${JSON.stringify(
          cacao
        )}`
      );
      const signature = await onSign(cacaoMessage);

      this.client.logger.info(
        `[Push] Engine.registerIdentity > Got signature: ${signature}`
      );

      // Storing keys after signature creation to prevent having false statement
      // Eg, onSign failing / never resolving but having identity keys stored.
      (this.client as IWalletClient).identityKeys.set(accountId, {
        accountId,
        identityKeyPriv: privKeyHex,
        identityKeyPub: pubKeyHex,
      });

      this.client.logger.info(
        `[Push] Engine.registerIdentity > Registering on keyserver ${keyserverUrl}...`
      );

      const res = await fetch(`${keyserverUrl}/identity`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          cacao: {
            ...cacao,
            s: {
              ...cacao.s,
              s: signature,
            },
          },
        }),
      });

      if (res.status !== 200 && res.status !== 201) {
        throw new Error(
          `[Push] Engine.registerIdentity > Failed to register on keyserver ${res.status}`
        );
      }

      this.client.logger.info(
        `[Push] Engine.registerIdentity > Registered on keyserver ${keyserverUrl}, didKey: ${didKey}`
      );
      return didKey;
    }
  };
}
