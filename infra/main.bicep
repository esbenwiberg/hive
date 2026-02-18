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

// ── Derived names ────────────────────────────────────────────────────────────
var sanitizedEnvName = replace(environmentName, '-', '')
var uniqueSuffix = uniqueString(resourceGroup().id)
var acrName = '${sanitizedEnvName}${take(uniqueSuffix, 6)}'
var keyVaultName = '${environmentName}-kv'
var postgresServerName = '${environmentName}-pg'
var logAnalyticsName = '${environmentName}-logs'
var identityName = '${environmentName}-identity'

// ── Well-known role definition IDs ───────────────────────────────────────────
var keyVaultSecretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

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
resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
  }
}

// ── Azure Key Vault ──────────────────────────────────────────────────────────
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
  }
}

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
// This rule allows ANY Azure service (from any subscription) to connect to the database,
// not just the Container App. Acceptable for initial deployment but should be scoped down.
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

// ── Role Assignments ─────────────────────────────────────────────────────────

// Key Vault Secrets Officer on the Key Vault for the Managed Identity.
// Secrets Officer (not Secrets User) is required because the app writes
// user git tokens to Key Vault at runtime via the profile settings page.
resource kvSecretsOfficerRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, managedIdentity.id, keyVaultSecretsOfficerRoleId)
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsOfficerRoleId)
    principalId: managedIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// AcrPull on the ACR for the Managed Identity
resource acrPullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, managedIdentity.id, acrPullRoleId)
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: managedIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
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
module containerApp 'container-app.bicep' = {
  name: 'container-app'
  params: {
    location: location
    environmentName: environmentName
    logAnalyticsWorkspaceId: logAnalytics.id
    logAnalyticsSharedKey: logAnalytics.listKeys().primarySharedKey
    acrLoginServer: acr.properties.loginServer
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
output containerAppFqdn string = containerApp.outputs.containerAppFqdn
output acrName string = acr.name
output acrLoginServer string = acr.properties.loginServer
output keyVaultUri string = keyVault.properties.vaultUri
output postgresServerFqdn string = postgresServer.properties.fullyQualifiedDomainName
output dockerHostPublicIp string = deployDockerHost ? dockerHost.outputs.vmPublicIp : ''
output dockerHostPrivateIp string = deployDockerHost ? dockerHost.outputs.vmPrivateIp : ''
