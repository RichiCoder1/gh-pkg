const keytar = require('keytar');
const ora = require('ora');
const execa = require('execa');
const OAUTH_SERVICE_NAME = 'gh-pkg-helper://github.com';
const PKG_TOKEN_SERVICE_NAME = 'pkgs://github.com';

const providers = new Map([
    [
        'npm',
        {
            setter: async (token, args) => {
                const npm = execa('npm', ['set', `//npm.pkg.github.com/:_authToken=${token}`, args.local ? '' : '-g']);
                npm.stdout.pipe(process.stdout);
                npm.stderr.pipe(process.stderr);
                await npm;
                console.log('Registry config set.');
            },
        },
    ],
    [
        'docker',
        {
            setter: async (token, args) => {
                const docker = execa(
                    'docker',
                    ['login', '--username', args.user, '--password', token, 'docker.pkg.github.com'],
                    {
                        timeout: 15000,
                        cleanup: true,
                    }
                );
                docker.stdout.pipe(process.stdout);
                docker.stderr.pipe(process.stderr);
                await docker;
            },
            requiresUsername: true,
        },
    ],
]);

async function main() {
    const args = require('minimist')(process.argv.slice(2));
    const forceRefresh = !!args.forceRefresh;
    let org = args.org;
    console.log('Getting token...');
    const token = await getToken(forceRefresh);

    if (!args.provider || !providers.has(args.provider)) {
        const inquirer = require('inquirer');
        const responses = await inquirer.prompt([
            {
                type: 'list',
                name: 'provider',
                message: 'What package manager would you like to authenticate?',
                choices: Array.from(providers.keys()),
            },
        ]);
        if (!responses.provider) {
            throw Error('You must select a provider!');
        }
        args.provider = responses.provider;
    }

    let resolvedProvider = providers.get(args.provider);

    if (!args.user && resolvedProvider.requiresUsername) {
        const inquirer = require('inquirer');
        const responses = await inquirer.prompt([
            {
                type: 'text',
                name: 'user',
                message: `What's your username?`,
            },
        ]);
        if (!responses.user) {
            throw Error('You must provide a username for this provider!');
        }
        args.user = responses.user;
    }

    // if (!org) {
    //     const inquirer = require('inquirer');
    //     const got = require('got');

    //     const orgResponse = await got(`https://api.github.com/user/orgs`, {
    //         headers: {
    //             Authorization: `Bearer ${token}`
    //         },
    //         responseType: 'json',
    //     });
    //     const responses = await inquirer.prompt([
    //         {
    //             type: 'list',
    //             name: 'org',
    //             message: 'What organization are you getting packages from?',
    //             choices: orgResponse.body.map(org => org.login)
    //         },
    //     ]);
    //     if (!responses.org) {
    //         throw Error('You must select an organization!');
    //     }
    //     org = responses.org;
    // }

    const spinner = ora(`Setting up authentication for ${args.provider}...\n`).start();
    try {
        await resolvedProvider.setter(token, { ...args, org, meta: resolvedProvider });
        spinner.succeed('Done!');
    } catch (e) {
        spinner.fail(e);
    }
}

async function getToken(forceRefresh = false) {
    if (!forceRefresh) {
        const pkgTokens = await keytar.findCredentials(PKG_TOKEN_SERVICE_NAME);
        if (pkgTokens.length > 0) {
            console.log('Found package token. Using...');
            return pkgTokens[0].password;
        }
    }

    const open = require('open');
    const accounts = await keytar.findCredentials(OAUTH_SERVICE_NAME);
    let account = accounts ? accounts[0] : null;
    if (!account) {
        const inquirer = require('inquirer');

        const openAnswer = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'open_browser',
                message: 'In order to use this cli, you first need to create an OAuth app. Open browser now?',
            },
        ]);
        if (!openAnswer.open_browser) {
            console.warn("Can't continue without an app setup. Exiting...");
            process.exit(0);
        }

        console.warn(
            'Make sure you set the callback to http://localhost/auth-code/callback so this CLI can handle the callback!'
        );
        await open('https://github.com/settings/applications/new');

        const appAnswers = await inquirer.prompt([
            {
                type: 'input',
                name: 'client_id',
                message: "What's your Client ID?",
            },
            {
                type: 'password',
                name: 'client_secret',
                message: "What's your Client Secret?",
            },
        ]);

        await keytar.setPassword(OAUTH_SERVICE_NAME, appAnswers.client_id, appAnswers.client_secret);
        account = { account: appAnswers.client_id, password: appAnswers.client_secret };
    }

    const spinner = ora('Authenticating...').start();
    const express = require('express');

    let server = express();
    let listener;
    let callback;
    const callbackPromise = new Promise((res, rej) => (callback = { resolve: res, reject: rej }));
    server.get('/auth-code/callback', (req, res) => {
        res.send(`<a href="#" onclick="window.close();return false;">Close Window</a>`);
        listener.close();
        if (!req.query['code']) {
            console.error('Failed to authenticate:');
            console.error(req.query);
        } else {
            callback.resolve(req.query['code']);
        }
    });

    await new Promise((resolve, reject) => {
        try {
            listener = server.listen(51321, () => resolve());
        } catch (e) {
            reject(e);
        }
    });
    const authorizeUrl = new URL('https://github.com/login/oauth/authorize');
    authorizeUrl.search = new URLSearchParams({
        client_id: account.account,
        redirect_url: `http://localhost:51321/auth-code/callback`,
        scope: 'repo write:packages read:org',
        state: 'lol',
    });
    await open(authorizeUrl.toJSON());

    const code = await callbackPromise;

    const got = require('got');
    const tokenUrl = new URL('https://github.com/login/oauth/access_token');
    const tokenRequestBody = {
        client_id: account.account,
        client_secret: account.password,
        code,
        redirect_url: `http://localhost:51321/auth-code/callback`,
        state: 'lol',
    };

    spinner.text = 'Getting access_token...';
    const tokenResponse = await got.post(tokenUrl, {
        form: tokenRequestBody,
        responseType: 'json',
    });

    await keytar.setPassword(PKG_TOKEN_SERVICE_NAME, account.account, tokenResponse.body.access_token);
    spinner.stopAndPersist({ text: 'Got token!' });
    return tokenResponse.body.access_token;
}

main()
    .catch(console.error)
    .catch(() => process.exit(-1));
