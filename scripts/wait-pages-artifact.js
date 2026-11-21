const { setTimeout: sleep } = require('node:timers/promises');

const RETRY_DELAYS = [5000, 10000, 15000, 20000, 30000];

async function waitForPagesArtifact({ artifactName, artifactId, listArtifacts,
    wait = sleep, log = console.log }) {
    if (!/^github-pages-\d+-\d+$/.test(artifactName || '') || !/^[1-9]\d*$/.test(String(artifactId || ''))) {
        throw new Error('Missing or invalid Pages artifact identity from the build job');
    }
    const attempts = RETRY_DELAYS.length + 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        let result;
        try {
            result = await listArtifacts();
        } catch (error) {
            const status = Number(error.status || error.statusCode);
            if (![408, 429].includes(status) && !(status >= 500 && status <= 599)) {
                throw new Error('Pages artifact lookup failed; check Actions credentials or service connectivity', { cause: error });
            }
            log(`Pages artifact lookup ${attempt}/${attempts}: HTTP ${status}`);
        }
        if (result) {
            if (!Array.isArray(result.artifacts)) throw new Error('Invalid Pages artifact lookup response');
            const matches = result.artifacts.filter(artifact => artifact.name === artifactName);
            if (matches.length > 1) throw new Error('Multiple artifacts match the build output; refusing an ambiguous deployment');
            if (matches.length === 1) {
                const artifact = matches[0];
                if (String(artifact.id) !== String(artifactId)) throw new Error('Pages artifact ID does not match the build output');
                if (!(artifact.size > 0)) throw new Error('Pages artifact is empty');
                log(`Pages artifact ready: ${artifactName}, ID ${artifactId} (lookup ${attempt}/${attempts})`);
                return artifact;
            }
            log(`Pages artifact ${artifactName} not visible yet (lookup ${attempt}/${attempts})`);
        }
        if (attempt < attempts) {
            const delay = RETRY_DELAYS[attempt - 1];
            log(`Waiting ${delay / 1000}s before retrying artifact lookup`);
            await wait(delay);
        }
    }
    throw new Error(`Pages artifact ${artifactName} was not available after ${attempts} lookups; deployment was not started`);
}

async function checkPagesArtifact(env = process.env) {
    // Use the same internal artifact service as deploy-pages, not the REST list.
    // github-script supplies the Actions runtime credentials that shell steps lack.
    const { DefaultArtifactClient } = await import('@actions/artifact');
    const client = new DefaultArtifactClient();
    return waitForPagesArtifact({ artifactName: env.PAGES_ARTIFACT_NAME, artifactId: env.PAGES_ARTIFACT_ID,
        listArtifacts: () => client.listArtifacts() });
}

module.exports = { waitForPagesArtifact, checkPagesArtifact, RETRY_DELAYS };
