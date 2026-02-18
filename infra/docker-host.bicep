// ── docker-host.bicep ── Docker Host VM for preview environments ─────────────

@description('Azure region for all resources')
param location string

@description('Environment name used to derive resource names')
param environmentName string

@secure()
@description('SSH public key for VM admin access')
param adminSshPublicKey string

@description('Name of the Key Vault for storing Docker TLS certs')
param keyVaultName string

@description('Source address prefix allowed to reach Docker API and preview ports (CIDR notation)')
param allowedSourceAddressPrefix string

// ── Derived names ────────────────────────────────────────────────────────────
var vmName = '${environmentName}-docker'
var nicName = '${vmName}-nic'
var publicIpName = '${vmName}-pip'
var nsgName = '${vmName}-nsg'
var vnetName = '${vmName}-vnet'
var subnetName = 'docker-subnet'
var adminUsername = 'hiveadmin'

// ── Network Security Group ──────────────────────────────────────────────────

resource nsg 'Microsoft.Network/networkSecurityGroups@2023-11-01' = {
  name: nsgName
  location: location
  properties: {
    securityRules: [
      {
        name: 'AllowSSH'
        properties: {
          priority: 1000
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '22'
          sourceAddressPrefix: allowedSourceAddressPrefix
          destinationAddressPrefix: '*'
        }
      }
      {
        name: 'AllowDockerAPI'
        properties: {
          priority: 1100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '2376'
          sourceAddressPrefix: allowedSourceAddressPrefix
          destinationAddressPrefix: '*'
        }
      }
      {
        name: 'AllowPreviewPorts'
        properties: {
          priority: 1200
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '4001-4099'
          sourceAddressPrefix: allowedSourceAddressPrefix
          destinationAddressPrefix: '*'
        }
      }
      {
        name: 'DenyAllOtherInbound'
        properties: {
          priority: 4000
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourcePortRange: '*'
          destinationPortRange: '*'
          sourceAddressPrefix: '*'
          destinationAddressPrefix: '*'
        }
      }
    ]
  }
}

// ── Virtual Network + Subnet ────────────────────────────────────────────────

resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: vnetName
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.1.0.0/16'
      ]
    }
    subnets: [
      {
        name: subnetName
        properties: {
          addressPrefix: '10.1.0.0/24'
          networkSecurityGroup: {
            id: nsg.id
          }
        }
      }
    ]
  }
}

// ── Public IP Address ───────────────────────────────────────────────────────

resource publicIp 'Microsoft.Network/publicIPAddresses@2023-11-01' = {
  name: publicIpName
  location: location
  sku: {
    name: 'Standard'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
  }
}

// ── Network Interface ───────────────────────────────────────────────────────

resource nic 'Microsoft.Network/networkInterfaces@2023-11-01' = {
  name: nicName
  location: location
  properties: {
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          subnet: {
            id: vnet.properties.subnets[0].id
          }
          publicIPAddress: {
            id: publicIp.id
          }
          privateIPAllocationMethod: 'Dynamic'
        }
      }
    ]
  }
}

// ── Virtual Machine ─────────────────────────────────────────────────────────

resource vm 'Microsoft.Compute/virtualMachines@2024-03-01' = {
  name: vmName
  location: location
  properties: {
    hardwareProfile: {
      vmSize: 'Standard_B2s'
    }
    osProfile: {
      computerName: vmName
      adminUsername: adminUsername
      linuxConfiguration: {
        disablePasswordAuthentication: true
        ssh: {
          publicKeys: [
            {
              path: '/home/${adminUsername}/.ssh/authorized_keys'
              keyData: adminSshPublicKey
            }
          ]
        }
      }
    }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: 'ubuntu-24_04-lts'
        sku: 'server'
        version: 'latest'
      }
      osDisk: {
        createOption: 'FromImage'
        managedDisk: {
          storageAccountType: 'Standard_LRS'
        }
      }
    }
    networkProfile: {
      networkInterfaces: [
        {
          id: nic.id
        }
      ]
    }
  }
}

// ── Custom Script Extension — Install and configure Docker CE ───────────────

resource dockerInstallScript 'Microsoft.Compute/virtualMachines/extensions@2024-03-01' = {
  parent: vm
  name: 'install-docker'
  location: location
  properties: {
    publisher: 'Microsoft.Azure.Extensions'
    type: 'CustomScript'
    typeHandlerVersion: '2.1'
    autoUpgradeMinorVersion: true
    settings: {
      script: base64(loadTextContent('scripts/install-docker.sh'))
    }
  }
}

// ── Outputs ──────────────────────────────────────────────────────────────────
output vmPrivateIp string = nic.properties.ipConfigurations[0].properties.privateIPAddress
output vmPublicIp string = publicIp.properties.ipAddress
output vmResourceId string = vm.id
