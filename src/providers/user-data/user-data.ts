import { Injectable } from '@angular/core';
import { StorageProvider } from '@providers/storage/storage';
import { AuthProvider } from '@providers/auth/auth';
import { ForgeProvider } from '@providers/forge/forge';

import { Observable } from 'rxjs/Observable';
import { Subject } from 'rxjs/Subject';
import 'rxjs/add/operator/map';

import { Contact, Profile, Wallet, WalletKeys } from '@models/model';

import lodash from 'lodash';
import { v4 as uuid } from 'uuid';
import { Network, NetworkType } from 'ark-ts/model';

import * as constants from '@app/app.constants';
import { Delegate } from 'ark-ts';

@Injectable()
export class UserDataProvider {

  public profiles = {};
  public networks = {};

  public currentProfile: Profile;
  public currentNetwork: Network;
  public currentWallet: Wallet;

  public onActivateNetwork$: Subject<Network> = new Subject();
  public onCreateWallet$: Subject<Wallet> = new Subject();
  public onUpdateWallet$: Subject<Wallet> = new Subject();
  public onSelectProfile$: Subject<Profile> = new Subject();

  public get isDevNet(): boolean {
    return this.currentNetwork && this.currentNetwork.type === NetworkType.Devnet;
  }

  constructor(
    private storageProvider: StorageProvider,
    private authProvider: AuthProvider,
    private forgeProvider: ForgeProvider,
  ) {
    this.loadAllData();

    this.onLogin();
    this.onClearStorage();
  }

  addNetwork(network: Network) {
    this.networks[this.generateUniqueId()] = network;

    return this.storageProvider.set(constants.STORAGE_NETWORKS, this.networks);
  }

  updateNetwork(networkId: string, network: Network) {
    this.networks[networkId] = network;

    return this.storageProvider.set(constants.STORAGE_NETWORKS, this.networks);
  }

  getNetworkById(networkId: string) {
    return this.networks[networkId];
  }

  removeNetworkById(networkId: string) {
    delete this.networks[networkId];

    this.storageProvider.set(constants.STORAGE_NETWORKS, this.networks);
    return this.networks;
  }

  addProfile(profile: Profile) {
    this.profiles[this.generateUniqueId()] = profile;

    return this.saveProfiles();
  }

  getProfileById(profileId: string) {
    return new Profile().deserialize(this.profiles[profileId]);
  }

  removeProfileById(profileId: string) {
    delete this.profiles[profileId];

    return this.saveProfiles();
  }

  saveProfiles(profiles = this.profiles) {
    const currentProfile = this.authProvider.loggedProfileId;

    if (currentProfile) { this.setCurrentProfile(currentProfile, false); }
    return this.storageProvider.set(constants.STORAGE_PROFILES, profiles);
  }

  encryptSecondPassphrase(wallet: Wallet,
                          pinCode: string,
                          secondPassphrase: string,
                          profileId: string = this.authProvider.loggedProfileId) {
    if (lodash.isUndefined(profileId)) { return; }

    if (wallet && !wallet.cipherSecondKey) {
      // wallet.secondBip38 = this.forgeProvider.encryptBip38(secondWif, pinCode, this.currentNetwork);
      wallet.cipherSecondKey = this.forgeProvider.encrypt(secondPassphrase, pinCode, wallet.address, wallet.iv);
      return this.saveWallet(wallet, profileId, true);
    }

    return this.saveProfiles();
  }

  addWallet(wallet: Wallet, passphrase: string, pinCode: string, profileId: string = this.authProvider.loggedProfileId) {
    if (lodash.isUndefined(profileId)) { return; }

    const profile = this.getProfileById(profileId);

    const iv = this.forgeProvider.generateIv();

    if (passphrase) {
      wallet.iv = iv;
      const cipherKey = this.forgeProvider.encrypt(passphrase, pinCode, wallet.address, iv);
      // wallet.bip38 = this.forgeProvider.encryptBip38(wif, pinCode, this.currentNetwork);
      wallet.cipherKey = cipherKey;
    }

    if (!profile.wallets[wallet.address] || profile.wallets[wallet.address].isWatchOnly) {
      this.onCreateWallet$.next(wallet);
      return this.saveWallet(wallet, profileId);
    }

    return this.saveProfiles();
  }

  updateWalletEncryption(oldPassword: string, newPassword: string) {
    for (const profileId in this.profiles) {
      const profile = this.profiles[profileId];
      for (const walletId in profile.wallets) {
        const wallet = profile.wallets[walletId];
        if (wallet.isWatchOnly) {
          continue;
        }
        const key = this.forgeProvider.decrypt(wallet.cipherKey, oldPassword, wallet.address, wallet.iv);
        wallet.cipherKey = this.forgeProvider.encrypt(key, newPassword, wallet.address, wallet.iv);
        // wallet.bip38 = this.forgeProvider.encryptBip38(wif, newPassword, this.currentNetwork);

        if (wallet.cipherSecondKey) {
          const secondKey = this.forgeProvider.decrypt(wallet.cipherSecondKey, oldPassword, wallet.address, wallet.iv);
          wallet.cipherSecondKey = this.forgeProvider.encrypt(secondKey, newPassword, wallet.address, wallet.iv);
          // wallet.secondBip38 = this.forgeProvider.encryptBip38(secondWif, newPassword, this.currentNetwork);
        }

        this.saveWallet(wallet, profileId);
      }
    }

    return this.saveProfiles();
  }

  removeWalletByAddress(address: string, profileId: string = this.authProvider.loggedProfileId): void {
    delete this.profiles[profileId]['wallets'][address];

    this.saveProfiles();
  }

  ensureWalletDelegateProperties(wallet: Wallet, delegateOrUserName: string | Delegate): void {
    if (!wallet) {
      return;
    }

    const userName: string = !delegateOrUserName || typeof delegateOrUserName === 'string'
                               ? delegateOrUserName as string
                               : delegateOrUserName.username;

    if (!userName || (wallet.isDelegate && wallet.username === userName)) {
      return;
    }

    wallet.isDelegate = true;
    wallet.username = userName;
    this.saveWallet(wallet, undefined, true);
  }

  getWalletByAddress(address: string, profileId: string = this.authProvider.loggedProfileId): Wallet {
    if (!address || lodash.isUndefined(profileId)) { return; }

    const profile = this.getProfileById(profileId);
    let wallet = new Wallet();

    if (profile.wallets[address]) {
      wallet = wallet.deserialize(profile.wallets[address]);
      wallet.loadTransactions(wallet.transactions);
      return wallet;
    }

    return null;
  }

  saveWallet(wallet: Wallet, profileId: string = this.authProvider.loggedProfileId, notificate: boolean = false) {
    if (lodash.isUndefined(profileId)) { return; }

    const profile = this.getProfileById(profileId);
    wallet.lastUpdate = new Date().getTime();
    profile.wallets[wallet.address] = wallet;

    this.profiles[profileId] = profile;

    if (notificate) { this.onUpdateWallet$.next(wallet); }

    return this.saveProfiles();
  }

  public getWalletLabel(walletOrAddress: Wallet | string): string {
    let wallet: Wallet;
    if (typeof walletOrAddress === 'string') {
      wallet = this.getWalletByAddress(walletOrAddress);
    } else {
      wallet = walletOrAddress;
    }

    if (!wallet) {
      return null;
    }

    return wallet.username || wallet.label || wallet.address;
  }

  setCurrentWallet(wallet: Wallet) {
    this.currentWallet = wallet;
  }

  clearCurrentWallet() {
    this.currentWallet = undefined;
  }

  public getCurrentProfile(): Profile {
    return this.profiles[this.authProvider.loggedProfileId];
  }

  loadProfiles() {
    return this.storageProvider
      .getObject(constants.STORAGE_PROFILES)
      .map(profiles => {
        // we have to create "real" contacts here, because the "address" property was not on the contact object
        // in the first versions of the app
        return lodash.mapValues(profiles, profile => {
          profile.contacts = lodash.transform(profile.contacts, UserDataProvider.mapContact, {});
          return profile;
        });
      });
  }

  loadNetworks() {
    const defaults = Network.getAll();

    return Observable.create((observer) => {
      // Return defaults networks from arkts
      this.storageProvider.getObject(constants.STORAGE_NETWORKS).subscribe((networks) => {
        if (!networks || lodash.isEmpty(networks)) {
          const uniqueDefaults = {};

          for (let i = 0; i < defaults.length; i++) {
            uniqueDefaults[this.generateUniqueId()] = defaults[i];
          }

          this.storageProvider.set(constants.STORAGE_NETWORKS, uniqueDefaults);
          observer.next(uniqueDefaults);
        } else {
          observer.next(networks);
        }

        observer.complete();
      });
    });
  }

  getKeysByWallet(wallet: Wallet, password: string): WalletKeys {
    if (!wallet.cipherKey && !wallet.cipherSecondKey) { return; }

    const keys: WalletKeys = {};

    if (wallet.cipherKey) {
      keys.key = this.forgeProvider.decrypt(wallet.cipherKey, password, wallet.address, wallet.iv);
    }

    if (wallet.cipherSecondKey) {
      keys.secondKey = this.forgeProvider.decrypt(wallet.cipherSecondKey, password, wallet.address, wallet.iv);
    }

    return keys;
  }

  // this method is required to "migrate" contacts, in the first version of the app the contact's didnt't include an address property
  private static mapContact = (contacts: { [address: string]: Contact }, contact: Contact, address: string): void => {
    contact.address = address;
    contacts[address] = contact;
  };

  private setCurrentNetwork(): void {
    if (!this.currentProfile) { return; }

    const network = new Network();

    Object.assign(network, this.networks[this.currentProfile.networkId]);
    this.onActivateNetwork$.next(network);

    this.currentNetwork = network;
  }

  private setCurrentProfile(profileId: string, broadcast: boolean = true): void {
    if (profileId && this.profiles[profileId]) {
      const profile = new Profile().deserialize(this.profiles[profileId]);
      this.currentProfile = profile;
      if (broadcast) { this.onSelectProfile$.next(profile); }
    } else {
      this.currentProfile = null;
      this.authProvider.logout(false);
    }
  }

  private loadAllData() {
    this.loadProfiles().subscribe(profiles => this.profiles = profiles);
    this.loadNetworks().subscribe(networks => this.networks = networks);
  }

  private onLogin() {
    return this.authProvider.onLogin$.subscribe((id) => {
      this.setCurrentProfile(id);
      this.setCurrentNetwork();
    });
  }

  private onClearStorage() {
    this.storageProvider.onClear$
      .debounceTime(100)
      .do(() => {
        this.loadAllData();

        this.setCurrentProfile(null);
      })
      .subscribe();
  }

  private generateUniqueId(): string {
    return uuid();
  }

}
