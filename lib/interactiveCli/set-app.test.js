'use strict';

const { join } = require('path');
const sinon = require('sinon');
const { readFile, writeFile } = require('fs-extra');
const yaml = require('yamljs');
const runServerless = require('@serverless/test/run-serverless');
const configureInquirerStub = require('@serverless/test/configure-inquirer-stub');
const { getLoggedInUser } = require('@serverless/platform-sdk');
const registerConfiguration = require('./register');

const setupServerless = require('../../test/setupServerless');

const dashboardPluginPath = require.resolve('../../');
const platformSdkPath = require.resolve('@serverless/platform-sdk');
const fixturesPath = join(__dirname, 'test/fixtures');
const nonAwsServicePath = join(fixturesPath, 'non-aws-service');
const awsServicePath = join(fixturesPath, 'aws-service');
const awsLoggedInServicePath = join(fixturesPath, 'aws-loggedin-service');
const awsLoggedInMonitoredServicePath = join(fixturesPath, 'aws-loggedin-monitored-service');
const awsLoggedInWrongOrgServicePath = join(fixturesPath, 'aws-loggedin-wrongorg-service');
const awsLoggedInNoAppServicePath = join(fixturesPath, 'aws-loggedin-noapp-service');
const awsLoggedInWrongAppServicePath = join(fixturesPath, 'aws-loggedin-wrongapp-service');

describe('interactiveCli: set-app', function() {
  this.timeout(1000 * 60 * 3);

  let serverlessPath;
  let inquirer;
  let backupIsTTY;
  let platformSdkStub;
  let modulesCacheStub;
  let createAppStub;
  let setDefaultDeploymentProfileStub;

  before(async () => {
    backupIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    serverlessPath = (await setupServerless()).root;
    const inquirerPath = join(serverlessPath, 'lib/plugins/interactiveCli/inquirer');
    inquirer = require(inquirerPath);
    createAppStub = sinon.spy(async ({ app }) => ({ appName: app }));
    setDefaultDeploymentProfileStub = sinon.stub().resolves();

    platformSdkStub = {
      configureFetchDefaults: () => {},
      createApp: createAppStub,
      getApps: async () => [{ appName: 'some-aws-service-app' }, { appName: 'other-app' }],
      getDeployProfiles: async () => [{ deploymentProfileUid: 'some-deploy-profile' }],
      getLoggedInUser,
      listTenants: async () => [
        { tenantName: 'testinteractivecli' },
        { tenantName: 'othertenant' },
      ],
      login: sinon.stub().resolves(),
      refreshToken: async () => {},
      setDefaultDeploymentProfile: setDefaultDeploymentProfileStub,
    };
    modulesCacheStub = {
      [require.resolve(inquirerPath)]: inquirer,
      [require.resolve('.//register')]: registerConfiguration,
      [require.resolve('../deployProfile')]: { configureDeployProfile: async () => {} },
      [platformSdkPath]: platformSdkStub,
    };
    sinon.stub(registerConfiguration, 'check').resolves(false);
  });
  after(() => {
    process.stdin.isTTY = backupIsTTY;
    sinon.restore();
  });

  afterEach(() => {
    if (inquirer.prompt.restore) inquirer.prompt.restore();
    sinon.reset();
  });

  it('Should be ineffective, when not at service path', () =>
    runServerless(serverlessPath, {
      cwd: fixturesPath,
      pluginPathsWhitelist: [dashboardPluginPath],
      lifecycleHookNamesWhitelist: ['before:interactiveCli:setupAws'],
      modulesCacheStub,
    }));

  it('Should be ineffective, when not at AWS service path', () => {
    return runServerless(serverlessPath, {
      cwd: nonAwsServicePath,
      pluginPathsWhitelist: [dashboardPluginPath],
      lifecycleHookNamesWhitelist: ['before:interactiveCli:setupAws'],
      modulesCacheStub,
    });
  });

  it('Should be ineffective, when not logged in', () => {
    return runServerless(serverlessPath, {
      cwd: awsServicePath,
      pluginPathsWhitelist: [dashboardPluginPath],
      lifecycleHookNamesWhitelist: ['before:interactiveCli:setupAws'],
      modulesCacheStub,
    });
  });

  it('Should be ineffective, when no tenants are resolved', () => {
    return runServerless(serverlessPath, {
      cwd: awsLoggedInServicePath,
      pluginPathsWhitelist: [dashboardPluginPath],
      lifecycleHookNamesWhitelist: ['before:interactiveCli:setupAws'],
      modulesCacheStub: {
        ...modulesCacheStub,
        [platformSdkPath]: {
          ...platformSdkStub,
          listTenants: async () => [],
        },
      },
    });
  });

  it('Should be ineffective, when project has monitoring setup with recognized org and app', () => {
    return runServerless(serverlessPath, {
      cwd: awsLoggedInMonitoredServicePath,
      pluginPathsWhitelist: [dashboardPluginPath],
      lifecycleHookNamesWhitelist: ['before:interactiveCli:setupAws'],
      modulesCacheStub,
    });
  });

  it('Should reject an invalid app name', async () => {
    configureInquirerStub(inquirer, {
      confirm: { shouldEnableMonitoring: true },
      input: { newAppName: 'invalid app name /* Ć */' },
      list: { tenantName: 'testinteractivecli', appName: '_create_' },
    });
    try {
      await runServerless(serverlessPath, {
        cwd: awsLoggedInServicePath,
        pluginPathsWhitelist: [dashboardPluginPath],
        lifecycleHookNamesWhitelist: ['before:interactiveCli:setupAws'],
        modulesCacheStub,
      });
      throw new Error('Unexpected');
    } catch (error) {
      if (error.code !== 'INVALID_ANSWER') throw error;
    }
  });

  it('Should recognize an invalid org and allow to opt out', () => {
    configureInquirerStub(inquirer, {
      confirm: { shouldEnableMonitoring: true, shouldUpdateOrg: false },
    });
    return runServerless(serverlessPath, {
      cwd: awsLoggedInWrongOrgServicePath,
      pluginPathsWhitelist: [dashboardPluginPath],
      lifecycleHookNamesWhitelist: ['before:interactiveCli:setupAws'],
      modulesCacheStub,
    });
  });

  it('Should recognize an invalid app and allow to opt out', () => {
    configureInquirerStub(inquirer, {
      confirm: { shouldEnableMonitoring: true },
      list: { appUpdateType: 'skip' },
    });
    return runServerless(serverlessPath, {
      cwd: awsLoggedInWrongAppServicePath,
      pluginPathsWhitelist: [dashboardPluginPath],
      lifecycleHookNamesWhitelist: ['before:interactiveCli:setupAws'],
      modulesCacheStub,
    });
  });

  describe('Monitoring setup', () => {
    const serviceConfigPath = join(awsLoggedInServicePath, 'serverless.yml');
    let originalServiceConfig;
    before(async () => (originalServiceConfig = await readFile(serviceConfigPath)));
    afterEach(() => {
      if (originalServiceConfig) return writeFile(serviceConfigPath, originalServiceConfig);
      return null;
    });

    it('Should setup monitoring for chosen org and app', async () => {
      configureInquirerStub(inquirer, {
        confirm: { shouldEnableMonitoring: true },
        list: { tenantName: 'testinteractivecli', appName: 'other-app' },
      });
      const serverless = await runServerless(serverlessPath, {
        cwd: awsLoggedInServicePath,
        pluginPathsWhitelist: [dashboardPluginPath],
        lifecycleHookNamesWhitelist: ['before:interactiveCli:setupAws'],
        modulesCacheStub,
      });
      const serviceConfig = yaml.parse(String(await readFile(serviceConfigPath)));
      expect(serviceConfig.org).to.equal('testinteractivecli');
      expect(serviceConfig.app).to.equal('other-app');
      expect(serverless.service.tenant).to.equal('testinteractivecli');
      expect(serverless.service.app).to.equal('other-app');
    });

    it('Should create new app when requested, and setup monitoring with it', async () => {
      configureInquirerStub(inquirer, {
        confirm: { shouldEnableMonitoring: true },
        input: { newAppName: 'frominput' },
        list: { tenantName: 'testinteractivecli', appName: '_create_' },
      });
      const serverless = await runServerless(serverlessPath, {
        cwd: awsLoggedInServicePath,
        pluginPathsWhitelist: [dashboardPluginPath],
        lifecycleHookNamesWhitelist: ['before:interactiveCli:setupAws'],
        modulesCacheStub,
      });
      const serviceConfig = yaml.parse(String(await readFile(serviceConfigPath)));
      expect(serviceConfig.org).to.equal('testinteractivecli');
      expect(serviceConfig.app).to.equal('frominput');
      expect(serverless.service.tenant).to.equal('testinteractivecli');
      expect(serverless.service.app).to.equal('frominput');
      expect(createAppStub.calledOnce).to.be.true;
      expect(setDefaultDeploymentProfileStub.calledOnce).to.be.true;
    });
  });

  describe('Monitoring setup when invalid org', () => {
    const serviceConfigPath = join(awsLoggedInWrongOrgServicePath, 'serverless.yml');
    let originalServiceConfig;
    before(async () => (originalServiceConfig = await readFile(serviceConfigPath)));
    afterEach(() => {
      if (originalServiceConfig) return writeFile(serviceConfigPath, originalServiceConfig);
      return null;
    });

    it('Should provide a way to setup monitoring with an invalid org setting', async () => {
      configureInquirerStub(inquirer, {
        confirm: { shouldEnableMonitoring: true, shouldUpdateOrg: true },
        list: { tenantName: 'testinteractivecli', appName: 'other-app' },
      });
      const serverless = await runServerless(serverlessPath, {
        cwd: awsLoggedInWrongOrgServicePath,
        pluginPathsWhitelist: [dashboardPluginPath],
        lifecycleHookNamesWhitelist: ['before:interactiveCli:setupAws'],
        modulesCacheStub,
      });
      const serviceConfig = yaml.parse(String(await readFile(serviceConfigPath)));
      expect(serviceConfig.org).to.equal('testinteractivecli');
      expect(serviceConfig.app).to.equal('other-app');
      expect(serverless.service.tenant).to.equal('testinteractivecli');
      expect(serverless.service.app).to.equal('other-app');
    });
  });

  describe('Monitoring setup when no app', () => {
    const serviceConfigPath = join(awsLoggedInNoAppServicePath, 'serverless.yml');
    let originalServiceConfig;
    before(async () => (originalServiceConfig = await readFile(serviceConfigPath)));
    afterEach(() => {
      if (originalServiceConfig) return writeFile(serviceConfigPath, originalServiceConfig);
      return null;
    });

    it('Should allow to setup app', async () => {
      configureInquirerStub(inquirer, {
        confirm: { shouldEnableMonitoring: true },
        list: { appName: 'other-app' },
      });
      const serverless = await runServerless(serverlessPath, {
        cwd: awsLoggedInNoAppServicePath,
        pluginPathsWhitelist: [dashboardPluginPath],
        lifecycleHookNamesWhitelist: ['before:interactiveCli:setupAws'],
        modulesCacheStub,
      });
      const serviceConfig = yaml.parse(String(await readFile(serviceConfigPath)));
      expect(serviceConfig.org).to.equal('testinteractivecli');
      expect(serviceConfig.app).to.equal('other-app');
      expect(serverless.service.tenant).to.equal('testinteractivecli');
      expect(serverless.service.app).to.equal('other-app');
    });
  });

  describe('Monitoring setup when invalid app', () => {
    const serviceConfigPath = join(awsLoggedInWrongAppServicePath, 'serverless.yml');
    let originalServiceConfig;
    before(async () => (originalServiceConfig = await readFile(serviceConfigPath)));
    afterEach(() => {
      if (originalServiceConfig) return writeFile(serviceConfigPath, originalServiceConfig);
      return null;
    });

    it('Should recognize an invalid app and allow to create it', async () => {
      configureInquirerStub(inquirer, {
        confirm: { shouldEnableMonitoring: true },
        list: { appUpdateType: 'create' },
      });
      const serverless = await runServerless(serverlessPath, {
        cwd: awsLoggedInWrongAppServicePath,
        pluginPathsWhitelist: [dashboardPluginPath],
        lifecycleHookNamesWhitelist: ['before:interactiveCli:setupAws'],
        modulesCacheStub,
      });
      const serviceConfig = yaml.parse(String(await readFile(serviceConfigPath)));
      expect(serviceConfig.org).to.equal('testinteractivecli');
      expect(serviceConfig.app).to.equal('not-created-app');
      expect(serverless.service.tenant).to.equal('testinteractivecli');
      expect(serverless.service.app).to.equal('not-created-app');
    });

    it('Should recognize an invalid app and allow to replace it with existing one', async () => {
      configureInquirerStub(inquirer, {
        confirm: { shouldEnableMonitoring: true },
        list: { appUpdateType: 'chooseExisting', appName: 'other-app' },
      });
      const serverless = await runServerless(serverlessPath, {
        cwd: awsLoggedInWrongAppServicePath,
        pluginPathsWhitelist: [dashboardPluginPath],
        lifecycleHookNamesWhitelist: ['before:interactiveCli:setupAws'],
        modulesCacheStub,
      });
      const serviceConfig = yaml.parse(String(await readFile(serviceConfigPath)));
      expect(serviceConfig.org).to.equal('testinteractivecli');
      expect(serviceConfig.app).to.equal('other-app');
      expect(serverless.service.tenant).to.equal('testinteractivecli');
      expect(serverless.service.app).to.equal('other-app');
    });
  });
});