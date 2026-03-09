// ── container-app.bicep ── Container App (environment created by main.bicep) ──

@description('Azure region for all resources')
param location string

@description('Environment name used to derive resource names')
param environmentName string

@description('Resource ID of the Container App Environment')
param containerAppEnvironmentId string

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

@description('Log Analytics workspace customer ID (for Azure Monitor KQL queries)')
param logAnalyticsWorkspaceId string

// ── Derived names ────────────────────────────────────────────────────────────
var containerAppName = environmentName
var containerAppEnvDefaultDomain = reference(containerAppEnvironmentId, '2024-03-01').defaultDomain

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
    managedEnvironmentId: containerAppEnvironmentId
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
            cpu: json('2.0')
            memory: '4Gi'
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
              value: 'https://${containerAppName}.${containerAppEnvDefaultDomain}/auth/callback'
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
              name: 'AZURE_MONITOR_WORKSPACE_ID'
              value: logAnalyticsWorkspaceId
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
