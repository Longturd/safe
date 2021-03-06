import { bindActionCreators } from '/libraries/redux/src/index.js';
import { addAccount, setAllKeys as setAllAccounts, updateLabel as updateAccountLabel } from '/elements/x-accounts/accounts-redux.js';
import MixinRedux from '/secure-elements/mixin-redux/mixin-redux.js';
import AccountsClient from './AccountsClient.standalone.es.js';
import { WalletType, setAllKeys as setAllWallets, login, logout, updateLabel as updateWalletLabel, setDefaultWallet, LEGACY } from './wallet-redux.js';

class AccountManager {
    static getInstance() {
        this._instance = this._instance || new AccountManager();
        window.accountManager = this._instance;
        return this._instance;
    }

    constructor() {
        this._launched = new Promise(res => this._resolveLaunched = res);
        this.accountsLoaded = new Promise(res => this._resolveAccountsLoaded = res);
    }

    async launch() {
        this.accountsClient = new AccountsClient();

        this.accounts = {
            get: (address) => MixinRedux.store.getState().accounts.entries.get(address),
        };

        this._bindStore();

        // listen to response from onboarding
        this.accountsClient.on(AccountsClient.RequestType.ONBOARD, (result, state) => {
            this._onOnboardingResult(result);
        }, (error, state) => {
            console.error('AccountsManager error', error);
            console.log('State', state);
        });
        this.accountsClient.checkRedirectResponse();

        // Kick off writing accounts to the store
        this._populateAccounts();

        this._resolveLaunched();
    }

    _bindStore() {
        this.store = MixinRedux.store;

        this.actions = bindActionCreators({
            addAccount,
            setAllAccounts,
            updateAccountLabel,
            setAllWallets,
            setDefaultWallet,
            login,
            logout,
            updateWalletLabel,
        }, this.store.dispatch);
    }

    async _populateAccounts() {
        await this._launched;

        /**
         * type key = {
         *     id: string
         *     label: string,
         *     accounts: Map<string, AddressInfoEntry>,
         *     contracts: [],
         *     type: WalletType,
         * }
         */

        let listedWallets;
        try {
            listedWallets = await this.accountsClient.list();
        } catch (error) {
            if (error.message === 'MIGRATION_REQUIRED') {
                this.accountsClient.migrate(new AccountsClient.RedirectRequestBehavior());
                return;
            }

            // TODO: Handle this case with a user notification?
            else if (error.message === 'WALLETS_LOST') listedWallets = [];

            else throw error;
        }

        const wallets = [];
        const accounts = [];

        listedWallets.forEach(key => {
            wallets.push({
                id: key.id,
                label: key.label,
                type: key.type,
                hasFile: !!key.hasFile,
                hasWords: !!key.hasWords,
            });

            Array.from(key.accounts.keys()).forEach(address => {
                const entry = {
                    address,
                    label: key.accounts.get(address).label,
                    type: AccountType.KEYGUARD_HIGH,
                    isLegacy: key.type === WalletType.LEGACY,
                    walletId: key.id,
                };
                accounts.push(entry);
            });
        });

        this.actions.setAllAccounts(accounts);
        this.actions.setAllWallets(wallets);

        // if empty legacy wallet is set as default, set the wallet with the most accounts as default instead
        const state = MixinRedux.store.getState();
        const legacyIsDefault = state.wallets.activeWalletId === LEGACY;
        if (legacyIsDefault) {
            const legacyIsEmpty = Array.from(state.accounts.entries.values())
                .filter(a => a.isLegacy)
                .length === 0;

            if (legacyIsEmpty) {
                const walletWithMostAccounts = listedWallets.sort(
                    (a, b) => a.accounts.size > b.accounts.size
                        ? -1
                        : a.accounts.size < b.accounts.size
                            ? 1
                            : 0
                )[0];

                if (walletWithMostAccounts) {
                    this.actions.setDefaultWallet(walletWithMostAccounts.id);
                }
            }
        }

        this._resolveAccountsLoaded();
    }

    /// PUBLIC API ///

    // async getDefaultAccount() {
    //     const defaultAccount = await this.keyguard.getDefaultAccount();
    //     defaultAccount.type = defaultAccount.type === 'high' ? AccountType.KEYGUARD_HIGH : AccountType.KEYGUARD_LOW;
    //     return defaultAccount;
    // }

    async onboard() {
        await this._launched;
        const result = this._invoke(
            'onboard',
            null,
            {
                appName: 'Nimiq Safe',
            },
            new AccountsClient.RedirectRequestBehavior()
        );
    }

    async create() {
        await this._launched;
        const result = await this._invoke('signup', null, {
            appName: 'Nimiq Safe',
        });
        this._onOnboardingResult(result);
    }

    async sign(tx) {
        await this._launched;
        const account = this.accounts.get(tx.sender);
        tx.walletId = account.walletId;
        return this._invoke('signTransaction', null, tx);
    }

    /**
     * @param {string} walletId
     * @param {string} [address]
     */
    async rename(walletId, address) {
        await this._launched;
        const result = await this._invoke('rename', null, {
            appName: 'Nimiq Safe',
            walletId,
            address,
        });

        this.actions.updateWalletLabel(result.walletId, result.label);
        result.accounts.forEach(account => this.actions.updateAccountLabel(account.address, account.label));
    }

    // async exportFile(walletId) {
    //     await this._launched;
    //     return this._invoke('exportFile', null, {
    //         appName: 'Nimiq Safe',
    //         walletId,
    //     });
    // }

    // async exportWords(walletId) {
    //     await this._launched;
    //     await this._invoke('exportWords', null, {
    //         appName: 'Nimiq Safe',
    //         walletId,
    //     });
    // }

    async export(walletId) {
        await this._launched;
        const result = await this._invoke('export', null, {
            appName: 'Nimiq Safe',
            walletId,
        });

        // Update hasFile/hasWords flags
        const wallet = MixinRedux.store.getState().wallets.entries.get(walletId);
        if (!wallet) return;
        const updatedWallet = Object.assign({}, wallet, {
            hasFile: result.hasFile,
            hasWords: result.hasWords,
        });

        // FIXME: Use a dedicated action to just update flags
        this.actions.login(updatedWallet);
    }

    async changePassphrase(walletId) {
        await this._launched;
        await this._invoke('changePassphrase', null, {
            appName: 'Nimiq Safe',
            walletId,
        });
    }

    async login() {
        await this._launched;
        const result = await this._invoke('login', null, {
            appName: 'Nimiq Safe',
        });
        this._onOnboardingResult(result);
    }

    async logout(walletId) {
        await this._launched;
        const result = await this._invoke('logout', null, {
            appName: 'Nimiq Safe',
            walletId,
        });
        if (result.success === true) this.actions.logout(walletId);
        else throw new Error('Logout failed');
    }

    async addAccount(walletId) {
        await this._launched;
        const result = await this._invoke('addAccount', null, {
            appName: 'Nimiq Safe',
            walletId,
        });
        const newAccount = result.account;
        newAccount.type = AccountType.KEYGUARD_HIGH;
        newAccount.walletId = walletId;
        this.actions.addAccount(newAccount);
    }

    // async importLedger() {
    //     await this._launched;
    //     const newKey = {
    //         address: await this.ledger.getAddress(true),
    //         type: AccountType.LEDGER,
    //         label: 'Ledger Account'
    //     };
    //     return this._import(newKey);
    // }

    // async confirmLedgerAddress(address) {
    //     return this.ledger.confirmAddress(address);
    // }

    // signMessage(msg, address) {
    //     throw new Error('Not implemented!'); return;

    //     const account = this.accounts.get(address);
    //     this._invoke('signMessage', account);
    // }

    _onOnboardingResult(result) {
        result.accounts.forEach(newAccount => {
            newAccount.type = AccountType.KEYGUARD_HIGH;
            newAccount.walletId = result.walletId;
            newAccount.isLegacy = result.type === WalletType.LEGACY;
            this.actions.addAccount(newAccount);
        });
        this.actions.login({
            id: result.walletId,
            label: result.label,
            type: result.type,
            hasFile: !!result.hasFile,
            hasWords: !!result.hasWords,
        });
    }

    // async _import(key) {
    //     this.actions.addAccount(key);

    //     // Find and add vesting accounts
    //     (await this.vesting.find([key.address]))
    //         .forEach((vestingKey) => {
    //             const k = Object.assign({}, vestingKey, {
    //                 type: AccountType.VESTING,
    //                 label: `Vesting Contract`
    //             });
    //             this.actions.addAccount(k);
    //         });
    // }

    _invoke(method, account, ...args) {
        return this.accountsClient[method](...args);
    }
}

export default AccountManager.getInstance();

// export default methodDict = {
//     'sign': {
//         1: 'sign',
//         2: null,
//         3: null
//     },
//     'rename': {
//         1: 'rename',
//         2: null,
//         3: null
//     },
//     'export': {
//         1: 'export',
//         2: null,
//         3: null
//     },
//     'signMessage': {
//         1: 'signMessage',
//         2: null,
//         3: null
//     }
// }

const AccountType = {
    KEYGUARD_HIGH: 1,
    KEYGUARD_LOW: 2,
    LEDGER: 3,
    VESTING: 4
};
