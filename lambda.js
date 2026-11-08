// Lambda-style adapter: AWS Lambda (API Gateway v1/v2, Function URL) and Netlify Functions.
// Handler name: "handler".
const { handle } = require("./src/app");

exports.handler = async (event) => {
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  let path = event.rawPath || event.path || "/";
  path = path.replace(/^\/\.netlify\/functions\/api/, "/api") || "/api"; // Netlify rewrite path -> public path
  const body = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body || "";
  const fwd = (headers["x-forwarded-for"] || "").split(",")[0].trim();

  const out = await handle({
    method: event.httpMethod || event.requestContext?.http?.method || "GET",
    path,
    query: event.queryStringParameters || {},
    headers,
    body,
    ip: headers["x-nf-client-connection-ip"] || fwd || event.requestContext?.identity?.sourceIp || event.requestContext?.http?.sourceIp || "unknown",
  });
  return { statusCode: out.status, headers: out.headers, body: out.body };
};
