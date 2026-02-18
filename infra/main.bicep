// ── main.bicep ── Orchestrator template for The Hive Azure infrastructure ────

@description('Azure region for all resources')
param location string = resourceGroup().location

@description('Environment name used to derive resource names')
param environmentName string = 'the-hive'

@secure()
@description('Administrator password for PostgreSQL Flexible Server')
param postgresAdminPassword string

@description('Container image tag to deploy')
param containerImageTag string = 'latest'

@description('Whether to deploy the Docker host VM for preview environments')
param deployDockerHost bool = true

@secure()
@description('SSH public key for Docker host VM admin access')
param dockerHostAdminSshPublicKey string = ''

@description('Source address prefix allowed to reach Docker host (CIDR or * for dev)')
param dockerHostAllowedSourceAddressPrefix string = '*'

@description('Whether to deploy the Container App (false on first run before image is pushed)')
param deployContainerApp bool = true

// ── Derived names ────────────────────────────────────────────────────────────
var sanitizedEnvName = replace(environmentName, '-', '')
var uniqueSuffix = uniqueString(resourceGroup().id)
var acrName = '${sanitizedEnvName}${take(uniqueSuffix, 6)}'
var keyVaultName = '${environmentName}-kv'
var postgresServerName = '${environmentName}-pg'
var logAnalyticsName = '${environmentName}-logs'
var identityName = '${environmentName}-identity'

// ── Log Analytics Workspace ──────────────────────────────────────────────────
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

// ── Azure Container Registry ─────────────────────────────────────────────────
// Admin user enabled so Container App can pull images without role assignments.
resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: true
  }
}

// ── Azure Key Vault ──────────────────────────────────────────────────────────
// Uses access policies instead of RBAC to avoid needing role assignment permissions.
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: false
    accessPolicies: [
      // Grant the managed identity full secret access
      {
        tenantId: subscription().tenantId
        objectId: managedIdentity.properties.principalId
        permissions: {
          secrets: ['get', 'list', 'set', 'delete']
        }
      }
      // Grant the deploying user secret access (so setup.sh can seed secrets)
      {
        tenantId: subscription().tenantId
        objectId: deployingUserObjectId
        permissions: {
          secrets: ['get', 'list', 'set', 'delete']
        }
      }
    ]
  }
}

// The object ID of the user running the deployment, for Key Vault access policy.
// Defaults to empty — setup.sh passes this automatically.
@description('Object ID of the deploying user (for Key Vault access policy)')
param deployingUserObjectId string = ''

// ── Azure Database for PostgreSQL Flexible Server ────────────────────────────
resource postgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01-preview' = {
  name: postgresServerName
  location: location
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: 'hiveadmin'
    administratorLoginPassword: postgresAdminPassword
    storage: {
      storageSizeGB: 32
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
  }
}

resource postgresDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-12-01-preview' = {
  parent: postgresServer
  name: 'hive'
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// Applied after database creation to avoid ServerIsBusy race condition
resource postgresSSLConfig 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2023-12-01-preview' = {
  parent: postgresServer
  name: 'require_secure_transport'
  dependsOn: [postgresDatabase]
  properties: {
    value: 'ON'
    source: 'user-override'
  }
}

// TODO: Replace with VNet integration + private endpoints for production hardening.
resource postgresFirewallAllowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-12-01-preview' = {
  parent: postgresServer
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

// ── User-Assigned Managed Identity ───────────────────────────────────────────
resource managedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
}

// ── Key Vault Secrets ────────────────────────────────────────────────────────
// All secrets referenced by the Container App must exist before it provisions.
// The setup script overwrites placeholders with real values in step 5.

resource databaseUrlSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'database-url'
  properties: {
    value: 'postgresql://hiveadmin:${postgresAdminPassword}@${postgresServer.properties.fullyQualifiedDomainName}:5432/hive?sslmode=require'
  }
}

resource anthropicApiKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'anthropic-api-key'
  properties: {
    value: 'placeholder-overwritten-by-setup-script'
  }
}

resource sessionSecretKv 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'session-secret'
  properties: {
    value: 'placeholder-overwritten-by-setup-script'
  }
}

resource entraClientIdSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'entra-client-id'
  properties: {
    value: 'placeholder-overwritten-by-setup-script'
  }
}

resource entraClientSecretKv 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'entra-client-secret'
  properties: {
    value: 'placeholder-overwritten-by-setup-script'
  }
}

// ── Container App Module ─────────────────────────────────────────────────────
// Conditional: skipped on first run (before image is pushed to ACR)
module containerApp 'container-app.bicep' = if (deployContainerApp) {
  name: 'container-app'
  params: {
    location: location
    environmentName: environmentName
    logAnalyticsWorkspaceId: logAnalytics.id
    logAnalyticsSharedKey: logAnalytics.listKeys().primarySharedKey
    acrLoginServer: acr.properties.loginServer
    acrAdminUsername: acr.listCredentials().username
    acrAdminPassword: acr.listCredentials().passwords[0].value
    containerImageTag: containerImageTag
    keyVaultName: keyVault.name
    managedIdentityId: managedIdentity.id
    managedIdentityClientId: managedIdentity.properties.clientId
  }
}

// ── Docker Host VM Module ───────────────────────────────────────────────────
module dockerHost 'docker-host.bicep' = if (deployDockerHost) {
  name: 'docker-host'
  params: {
    location: location
    environmentName: environmentName
    adminSshPublicKey: dockerHostAdminSshPublicKey
    keyVaultName: keyVault.name
    allowedSourceAddressPrefix: dockerHostAllowedSourceAddressPrefix
  }
}

// ── Outputs ──────────────────────────────────────────────────────────────────
output containerAppFqdn string = deployContainerApp ? containerApp.outputs.containerAppFqdn : ''
output acrName string = acr.name
output acrLoginServer string = acr.properties.loginServer
output keyVaultUri string = keyVault.properties.vaultUri
output postgresServerFqdn string = postgresServer.properties.fullyQualifiedDomainName
output dockerHostPublicIp string = deployDockerHost ? dockerHost.outputs.vmPublicIp : ''
output dockerHostPrivateIp string = deployDockerHost ? dockerHost.outputs.vmPrivateIp : ''
