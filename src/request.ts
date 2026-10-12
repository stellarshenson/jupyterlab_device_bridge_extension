import { URLExt } from '@jupyterlab/coreutils';

import { ServerConnection } from '@jupyterlab/services';

/** URL namespace of the server extension. */
const API_NAMESPACE = 'jupyterlab-device-bridge-extension';

/**
 * Build the WebSocket URL of the device bridge.
 *
 * The token goes into the query, because the WebSocket constructor cannot set headers.
 *
 * @param serverSettings The server settings of the lab
 * @returns The absolute `ws:` or `wss:` URL of the bridge endpoint
 */
export function deviceBridgeWsUrl(
  serverSettings: ServerConnection.ISettings
): string {
  const url = URLExt.join(serverSettings.wsUrl, API_NAMESPACE, 'ws');
  return serverSettings.token
    ? `${url}?token=${encodeURIComponent(serverSettings.token)}`
    : url;
}

/**
 * Call the server extension
 *
 * @param endPoint API REST end point for the extension
 * @param serverSettings The server settings to use for the request
 * @param init Initial values for the request
 * @returns The response body interpreted as JSON
 * @throws ServerConnection.NetworkError when the request does not reach the server
 * @throws ServerConnection.ResponseError when the server answers with an error status;
 *   its message is the `error.message` of the response body
 */
export async function requestAPI<T>(
  endPoint: string,
  serverSettings: ServerConnection.ISettings,
  init: RequestInit = {}
): Promise<T> {
  // Make request to Jupyter API
  const requestUrl = URLExt.join(
    serverSettings.baseUrl,
    API_NAMESPACE,
    endPoint
  );

  let response: Response;
  try {
    response = await ServerConnection.makeRequest(
      requestUrl,
      init,
      serverSettings
    );
  } catch (error) {
    throw new ServerConnection.NetworkError(error as any);
  }

  let data: any = await response.text();

  if (data.length > 0) {
    try {
      data = JSON.parse(data);
    } catch (error) {
      console.log('Not a JSON response body.', response);
    }
  }

  if (!response.ok) {
    throw new ServerConnection.ResponseError(
      response,
      data.error?.message || data.message || data
    );
  }

  return data;
}
