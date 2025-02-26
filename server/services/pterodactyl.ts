import { ofetch } from 'ofetch'
import { servers, users } from '@prisma/client'
import prisma from '../lib/prisma'
import { Allocation, NodeResource, NodeWithLocation, PterodactylServer, ServerCreateParams } from '~/types/pterodactyl'

export class PterodactylService {
  private readonly config = {
    host: useRuntimeConfig().public.pterodactylUrl,
    apiKey: useRuntimeConfig().pterodactylApiKey
  }

  async createServer(user: users, config: ServerCreateParams): Promise<servers> {
    const user_uid = await prisma.users.findUnique({
      where: { email: user.email }
    })
    if (!user_uid) throw new Error('User not found')
    const pterodactylUserId = await this.findOrCreateUser(user)
    console.log('[Pterodactyl] User ID:', pterodactylUserId)
    const serverDetails = await this.createPterodactylServer(pterodactylUserId, config)
    console.log('[Pterodactyl] Nuxt User ID:', user_uid)
    
    return prisma.servers.create({
      data: {
        user_id: user_uid.id,
        pterodactyl_server_id: serverDetails.id.toString(),
        // identifier: serverDetails.identifier,
        config: {
          memory: config.memory,
          cpu: config.cpu,
          disk: config.disk
        },
        status: 'installing',
        game_type: 'minecraft'
        // game_type: config.game_type // Add the missing game_type property
      }
    })
  }

//   private 
  async findOrCreateUser(user: users): Promise<string> {
    try {
      const response = await ofetch(`${this.config.host}/api/application/users?filter[email]=${user.email}`, {
        headers: this.getHeaders()
      })

      console.debug('[Pterodactyl] User search response:', response)

      if (response.data.length > 0) {
        console.log(`[Pterodactyl] Existing user found: ${response.data[0].attributes.id}`)
        return response.data[0].attributes.id
      }
    //   if (response.data.length > 0) return response.data[0].attributes.id

      console.log('[Pterodactyl] Creating new user for:', user.email)
      const newUser = await ofetch(`${this.config.host}/api/application/users`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: {
          email: user.email,
          username: this.generateUsername(user.email),
          first_name: user.first_name,
          last_name: user.last_name,
          // password: this.generatePassword() Disable password generation for now
        },
        parseResponse: JSON.parse
      })

      // Directly access attributes from root object
        if (!(newUser as any)?.attributes) {
            throw new Error('Invalid egg data response structure');
        }

      console.log('[Pterodactyl] User creation response:', newUser)

      prisma.users.update({
        where: { id: newUser.id },
        data: { pterodactyl_user_id: newUser.attributes.id }
        })
      return newUser.attributes.id
    } catch (error) {
      if (error instanceof Error) {
        console.error('[Pterodactyl] User creation failed:', {
            error: (error as any).data?.errors || (error as any).message,
            config: this.config,
            user
        })
        throw new Error(`Pterodactyl user creation failed: ${(error as any).data?.errors?.[0]?.detail || error.message}`)
      } else {
        throw new Error('Pterodactyl user creation failed: Unknown error')
      }
    }
  }

  async findAvailableNode(location: string, requiredMemory: number, requiredDisk: number): Promise<number> {
    try {
      const response = await ofetch(`${this.config.host}/api/application/nodes`, {
        headers: this.getHeaders(),
        query: {
          filter: JSON.stringify({ location }),
          include: 'allocations'
        }
      });
  
      const nodes = response.data
        .map((n: any) => n.attributes)
        .filter((node: NodeResource) => 
          !node.maintenance_mode &&
          this.nodeHasCapacity(node, requiredMemory, requiredDisk)
        );
  
      if (!nodes.length) {
        throw new Error(`No available nodes in ${location} with sufficient resources`);
      }
  
      // Prioritize nodes with more available resources
      return nodes.sort((a: NodeResource, b: NodeResource) => 
        this.calculateAvailableMemory(b) - this.calculateAvailableMemory(a)
      )[0].id;
    } catch (error) {
      console.error('Node selection failed:', error);
      throw new Error('Failed to find available node');
    }
  }
  
  private nodeHasCapacity(node: NodeResource, requiredMemory: number, requiredDisk: number): boolean {
    const hasMemory = node.memory_overallocate === -1 ? true :
      (node.allocated_resources.memory + requiredMemory) <= 
      (node.memory * (node.memory_overallocate / 100 + 1));
  
    const hasDisk = node.disk_overallocate === -1 ? true :
      (node.allocated_resources.disk + requiredDisk) <= 
      (node.disk * (node.disk_overallocate / 100 + 1));
  
    return hasMemory && hasDisk;
  }
  
  private calculateAvailableMemory(node: NodeResource): number {
    if (node.memory_overallocate === -1) return Infinity;
    return (node.memory * (node.memory_overallocate / 100 + 1)) - node.allocated_resources.memory;
  }
  
  async findAvailableNodeWithAllocation(location: number, requiredMemory: number, requiredDisk: number): Promise<{ nodeId: number, allocationId: number }> {
    try {
      // 1. Get all nodes in the selected location
      const nodes = await this.getNodesByLocation(location);
      console.log('[Pterodactyl] Nodes:', nodes);
      
      // 2. Filter and sort nodes
      const suitableNodes = nodes
        .filter(node => 
          !node.maintenance_mode &&
          this.nodeHasCapacity(node, requiredMemory, requiredDisk)
        )
        .sort((a, b) => 
          this.calculateAvailableResources(b) - this.calculateAvailableResources(a)
        );
  
      if (!suitableNodes.length) {
        throw new Error(`No available nodes in location "${location}" with sufficient resources`);
      }
  
      // 3. Find first node with available allocations
      for (const node of suitableNodes) {
        const allocations = await this.getAvailableAllocations(node.id);
        if (allocations.length > 0) {
          return {
            nodeId: node.id,
            allocationId: allocations[0].id
          };
        }
      }
  
      throw new Error(`No available allocations in location "${location}" nodes`);
    } catch (error) {
      console.error('Node/allocation selection failed:', {
        location,
        requiredMemory,
        requiredDisk,
        error: (error as Error).message
      });
      throw error;
    }
  }
  
  private async getNodesByLocation(location: number): Promise<NodeWithLocation[]> {
    console.log('[Pterodactyl] Fetching nodes for location:', location)
    const response = await ofetch(`${this.config.host}/api/application/nodes`, {
      headers: this.getHeaders(),
      query: {
        filter: JSON.stringify({ location_id: location }),
      }
    });
    console.log('[Pterodactyl] getNodesByLocation response:', JSON.stringify(response, null, 2));
    return response.data.map((n: any) => ({
      ...n.attributes,
      location: n.attributes.location_id
    }));
  }
  
  private async getAvailableAllocations(nodeId: number): Promise<Allocation[]> {
    const response = await ofetch(`${this.config.host}/api/application/nodes/${nodeId}/allocations`, {
      headers: this.getHeaders()
    });
  
    return response.data
      .map((a: any) => a.attributes)
      .filter((alloc: Allocation) => !alloc.assigned);
  }
  
  private calculateAvailableResources(node: NodeResource): number {
    // Prioritize nodes with more available memory and disk
    const availableMemory = node.memory_overallocate === -1 ? 
      Infinity : 
      node.memory * (1 + node.memory_overallocate/100) - node.allocated_resources.memory;
    
    const availableDisk = node.disk_overallocate === -1 ? 
      Infinity : 
      node.disk * (1 + node.disk_overallocate/100) - node.allocated_resources.disk;
  
    return Math.min(availableMemory, availableDisk);
  }
  

//   private 
  async createPterodactylServer(userId: string, config: ServerCreateParams): Promise<PterodactylServer> {
    try {
        const { nodeId, allocationId } = await this.findAvailableNodeWithAllocation(
            config.location,
            config.memory,
            config.disk
          );
        console.log('[Pterodactyl] Node and allocation:', nodeId, allocationId)
        
      console.log('[Pterodactyl] Fetching egg data:', config.nest, config.egg)
      const eggData = await this.getEggData(config.nest, config.egg)
      console.log('[Pterodactyl] Egg data:', eggData)
      const serverName = config.servername || `Server-${Date.now()}`
      console.log('[Pterodactyl] Creating server:', serverName)

      console.log('[Pterodactyl] Allocation:', config.allocation.default)

      const server = await $fetch(`${this.config.host}/api/application/servers`, {
        method: 'POST',
        headers: this.getHeaders(),
        parseResponse: JSON.parse,
        body: {
          name: serverName,
          user: userId,
          egg: config.egg,
          docker_image: eggData.docker_image,
          startup: eggData.startup,
          environment: await this.processEnvironment(eggData, config),
          limits: {
            memory: config.memory,
            swap: config.swap,
            disk: config.disk,
            io: config.io,
            cpu: config.cpu
          },
          feature_limits: {
            databases: config.databases,
            backups: config.backups,
            allocations: config.allocation_limit
          },
          allocation: {
            default: allocationId
          },
            node: nodeId,
        }
      })

        // console.log('[Pterodactyl] Raw response Server Creation:', JSON.stringify(server, null, 2));

        // Directly access attributes from root object
        if (!(server as any)?.attributes) {
            throw new Error('Invalid egg data response structure');
        }

        // console.log('[Pterodactyl] Server creation response:', server)
        const server_id = (server as any).attributes.id
        console.log('[Pterodactyl] Server ID:', server_id)
        const identifier = (server as any).attributes.identifier
        console.log('[Pterodactyl] Server Identifier:', identifier)

      return {
        id: server_id,
        identifier: identifier,
        // status: server.data.attributes.status,
        // allocation: server.data.attributes.allocations[0]
      }
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Server creation failed: ${(error as any).data?.errors?.[0]?.detail || error.message}`)
      } else {
        throw new Error('Server creation failed: Unknown error')
      }
    }
  }

//   private 
    async getEggData(nestId: number, eggId: number) {
        try {
          const response = await $fetch(
            `${this.config.host}/api/application/nests/${nestId}/eggs/${eggId}?include=variables`,
            { 
              headers: this.getHeaders(),
              parseResponse: JSON.parse
            }
          );
      
        //   console.log('[Pterodactyl] Raw response:', JSON.stringify(response, null, 2));
      
          // Directly access attributes from root object
          if (!(response as any)?.attributes) {
            throw new Error('Invalid egg data response structure');
          }
      
          return (response as any).attributes;
        } catch (error) {
          console.error('[Pterodactyl] getEggData error:', {
            nestId,
            eggId,
            error: (error as Error).message,
            response: (error as any).data
          });
          throw new Error(`Failed to get egg data: ${(error as Error).message}`);
        }
    }

  private getHeaders() {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      Accept: 'Application/vnd.Pterodactyl.v1+json',
      'Content-Type': 'application/json'
    }
  }

  private generateUsername(email: string): string {
    return email.split('@')[0].replace(/[^\w]/g, '').slice(0, 15)
  }

  private generatePassword(length = 16): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()'
    return Array.from(crypto.getRandomValues(new Uint32Array(length)))
      .map((n) => chars[n % chars.length])
      .join('')
  }

  // Add this method inside the PterodactylService class
private async processEnvironment(
    eggData: any,
    config: ServerCreateParams
  ): Promise<Record<string, any>> {
    const environment: Record<string, any> = {};
  
    // Process egg variables
    if (eggData?.relationships?.variables?.data) {
      for (const variable of eggData.relationships.variables.data) {
        const attr = variable.attributes;
        const envVar = attr.env_variable;
        
        // Use config value if provided, otherwise use egg default
        environment[envVar] = config[envVar as keyof ServerCreateParams] || attr.default_value;
      }
    }
  
    // Add port allocation handling if needed
    if (config.port_array) {
      try {
        const portConfig = JSON.parse(config.port_array);
        Object.assign(environment, this.processPortEnvironment(portConfig));
      } catch (error) {
        console.error('Invalid port array configuration:', error);
      }
    }
  
    return environment;
  }
  
  // Add port environment processing
  private processPortEnvironment(portConfig: Record<string, any>): Record<string, any> {
    const portEnvironment: Record<string, any> = {};
    
    for (const [key, value] of Object.entries(portConfig)) {
      if (key !== 'SERVER_PORT' && key !== 'NONE') {
        portEnvironment[key] = value;
      }
    }
    
    return portEnvironment;
  }
}