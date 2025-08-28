import { ccc } from "@ckb-ccc/core";
import { JSONRPCClient } from "json-rpc-2.0";

export function buildJsonRpcClient(url: string) {
  const client = new JSONRPCClient(
    (jsonRPCRequest: any): Promise<any> =>
      fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: ccc.stringify(jsonRPCRequest),
      }).then((response) => {
        if (response.status === 200) {
          // Use client.receive when you received a JSON-RPC response.
          return response
            .json()
            .then((jsonRPCResponse) => client.receive(jsonRPCResponse));
        } else if (jsonRPCRequest.id !== undefined) {
          return Promise.reject(new Error(response.statusText));
        }
      }),
  );
  return client;
}
