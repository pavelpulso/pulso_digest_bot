import { createServer } from "node:http"

export async function withServer(handler, run) {
	const server = createServer(handler)
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
	const url = `http://127.0.0.1:${server.address().port}/`
	try {
		return await run(url)
	} finally {
		server.closeAllConnections()
		await new Promise((resolve) => server.close(resolve))
	}
}
