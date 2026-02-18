// ── container-app.bicep ── Container App Environment and Container App ───────

@description('Azure region for all resources')
param location string

@description('Environment name used to derive resource names')
param environmentName string

@description('Resource ID of the Log Analytics workspace')
param logAnalyticsWorkspaceId string

@secure()
@description('Log Analytics workspace shared key')
param logAnalyticsSharedKey string

@description('ACR login server (e.g. myacr.azurecr.io)')
param acrLoginServer string

@secure()
@description('ACR admin username')
param acrAdminUsername string

@secure()
@description('ACR admin password')
param acrAdminPassword string

@description('Container image tag to deploy')
param containerImageTag string

@description('Name of the Key Vault')
param keyVaultName string

@description('Resource ID of the user-assigned managed identity')
param managedIdentityId string

@description('Client ID of the user-assigned managed identity')
param managedIdentityClientId string

// ── Derived names ────────────────────────────────────────────────────────────
var containerAppEnvName = '${environmentName}-env'
var containerAppName = environmentName

// ── Container App Environment ────────────────────────────────────────────────
resource containerAppEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: containerAppEnvName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: reference(logAnalyticsWorkspaceId, '2023-09-01').customerId
        sharedKey: logAnalyticsSharedKey
      }
    }
  }
}

// ── Container App ────────────────────────────────────────────────────────────
resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: containerAppName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppEnv.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
      }
      registries: [
        {
          server: acrLoginServer
          username: acrAdminUsername
          passwordSecretRef: 'acr-password'
        }
      ]
      secrets: [
        {
          name: 'acr-password'
          value: acrAdminPassword
        }
        {
          name: 'database-url'
          keyVaultUrl: 'https://${keyVaultName}${environment().suffixes.keyvaultDns}/secrets/database-url'
          identity: managedIdentityId
        }
        {
          name: 'anthropic-api-key'
          keyVaultUrl: 'https://${keyVaultName}${environment().suffixes.keyvaultDns}/secrets/anthropic-api-key'
          identity: managedIdentityId
        }
        {
          name: 'session-secret'
          keyVaultUrl: 'https://${keyVaultName}${environment().suffixes.keyvaultDns}/secrets/session-secret'
          identity: managedIdentityId
        }
        {
          name: 'entra-client-id'
          keyVaultUrl: 'https://${keyVaultName}${environment().suffixes.keyvaultDns}/secrets/entra-client-id'
          identity: managedIdentityId
        }
        {
          name: 'entra-client-secret'
          keyVaultUrl: 'https://${keyVaultName}${environment().suffixes.keyvaultDns}/secrets/entra-client-secret'
          identity: managedIdentityId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'hive'
          image: '${acrLoginServer}/hive:${containerImageTag}'
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          env: [
            {
              name: 'DATABASE_URL'
              secretRef: 'database-url'
            }
            {
              name: 'ANTHROPIC_API_KEY'
              secretRef: 'anthropic-api-key'
            }
            {
              name: 'SESSION_SECRET'
              secretRef: 'session-secret'
            }
            {
              name: 'ENTRA_CLIENT_ID'
              secretRef: 'entra-client-id'
            }
            {
              name: 'ENTRA_CLIENT_SECRET'
              secretRef: 'entra-client-secret'
            }
            {
              name: 'ENTRA_TENANT_ID'
              value: subscription().tenantId
            }
            {
              name: 'REDIRECT_URI'
              value: 'https://${containerAppName}.${containerAppEnv.properties.defaultDomain}/auth/callback'
            }
            {
              name: 'AZURE_KEYVAULT_URI'
              value: 'https://${keyVaultName}${environment().suffixes.keyvaultDns}/'
            }
            {
              name: 'AZURE_CLIENT_ID'
              value: managedIdentityClientId
            }
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            {
              name: 'PORT'
              value: '3000'
            }
            {
              name: 'LOG_LEVEL'
              value: 'info'
            }
            {
              name: 'HIVE_MODE'
              value: 'daemon'
            }
            {
              name: 'HIVE_MAX_WORKERS'
              value: '5'
            }
            {
              name: 'HIVE_POLL_MS'
              value: '5000'
            }
            {
              name: 'HIVE_WORKTREE_DIR'
              value: '/repos'
            }
            {
              name: 'HIVE_PRODUCER_INTERVAL_MS'
              value: '900000'
            }
            {
              name: 'HIVE_DAEMON_USER_ID'
              value: '1'
            }
            {
              name: 'HIVE_DEFAULT_REPO_ID'
              value: '1'
            }
          ]
          probes: [
            {
              type: 'Startup'
              httpGet: {
                path: '/api/health'
                port: 3000
              }
              periodSeconds: 10
              failureThreshold: 30
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/api/health'
                port: 3000
              }
              periodSeconds: 30
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/api/health'
                port: 3000
              }
              periodSeconds: 10
              failureThreshold: 3
            }
          ]
          volumeMounts: [
            {
              volumeName: 'repos'
              mountPath: '/repos'
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
      volumes: [
        {
          name: 'repos'
          storageType: 'EmptyDir'
        }
      ]
    }
  }
}

// ── Outputs ──────────────────────────────────────────────────────────────────
output containerAppFqdn string = containerApp.properties.configuration.ingress.fqdn
