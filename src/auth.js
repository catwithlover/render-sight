import { createRemoteJWKSet, jwtVerify } from 'jose';

const accessJwksByTeamDomain = new Map();

function getTeamDomain(value) {
	if (typeof value !== 'string') {
		return null;
	}

	try {
		const url = new URL(value);
		if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) {
			return null;
		}

		return url.origin;
	} catch {
		return null;
	}
}

function getAccessJwks(teamDomain) {
	let jwks = accessJwksByTeamDomain.get(teamDomain);

	if (!jwks) {
		jwks = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', teamDomain));
		accessJwksByTeamDomain.set(teamDomain, jwks);
	}

	return jwks;
}

function authenticationError(status, message) {
	return new Response(message, {
		status,
		headers: {
			'cache-control': 'no-store',
			'content-type': 'text/plain; charset=utf-8',
		},
	});
}

export async function authenticateAccessRequest(request, env) {
	const teamDomain = getTeamDomain(env.TEAM_DOMAIN);
	const audience = typeof env.POLICY_AUD === 'string' ? env.POLICY_AUD.trim() : '';

	if (!teamDomain || !audience) {
		console.error(JSON.stringify({ message: 'Cloudflare Access authentication is not configured' }));
		return authenticationError(500, 'Authentication is not configured.');
	}

	const token = request.headers.get('cf-access-jwt-assertion');
	if (!token) {
		return authenticationError(403, 'Forbidden');
	}

	try {
		const { payload } = await jwtVerify(token, getAccessJwks(teamDomain), {
			algorithms: ['RS256'],
			audience,
			issuer: teamDomain,
			requiredClaims: ['exp', 'sub'],
		});
		if (typeof payload.sub !== 'string' || !payload.sub) {
			throw new Error('Access JWT subject is missing.');
		}

		return {
			subject: payload.sub,
			user: typeof payload.email === 'string' && payload.email ? payload.email : null,
		};
	} catch (error) {
		console.warn(
			JSON.stringify({
				message: 'Cloudflare Access JWT validation failed',
				error: error instanceof Error ? error.name : 'UnknownError',
			}),
		);
		return authenticationError(403, 'Forbidden');
	}
}
