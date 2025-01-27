import { ConflictException, Injectable, Logger } from '@nestjs/common'
import {
  Authority,
  Project,
  SecretVersion,
  User,
  Workspace
} from '@prisma/client'
import { CreateProject } from '../dto/create.project/create.project'
import { UpdateProject } from '../dto/update.project/update.project'
import { createKeyPair } from '../../common/create-key-pair'
import { excludeFields } from '../../common/exclude-fields'
import { PrismaService } from '../../prisma/prisma.service'
import { decrypt } from '../../common/decrypt'
import { encrypt } from '../../common/encrypt'
import getWorkspaceWithAuthority from '../../common/get-workspace-with-authority'
import getProjectWithAuthority from '../../common/get-project-with-authority'
import { v4 } from 'uuid'

@Injectable()
export class ProjectService {
  private readonly log: Logger = new Logger(ProjectService.name)

  constructor(private readonly prisma: PrismaService) {}

  async createProject(
    user: User,
    workspaceId: Workspace['id'],
    dto: CreateProject
  ): Promise<Project> {
    // Check if the workspace exists or not
    await getWorkspaceWithAuthority(
      user.id,
      workspaceId,
      Authority.CREATE_SECRET,
      this.prisma
    )

    // Check if project with this name already exists for the user
    if (await this.projectExists(dto.name, workspaceId))
      throw new ConflictException(
        `Project with this name **${dto.name}** already exists`
      )

    // Create the public and private key pair
    const { publicKey, privateKey } = createKeyPair()

    const data: Partial<Project> = {
      name: dto.name,
      description: dto.description,
      storePrivateKey: dto.storePrivateKey,
      publicKey
    }

    // Check if the private key should be stored
    // PLEASE DON'T STORE YOUR PRIVATE KEYS WITH US!!
    if (dto.storePrivateKey) {
      data.privateKey = privateKey
    }

    const userId = user.id

    const newProjectId = v4()

    const adminRole = await this.prisma.workspaceRole.findFirst({
      where: {
        workspaceId: workspaceId,
        hasAdminAuthority: true
      }
    })

    // Create and return the project
    const createNewProject = this.prisma.project.create({
      data: {
        id: newProjectId,
        name: data.name,
        description: data.description,
        publicKey: data.publicKey,
        privateKey: data.privateKey,
        storePrivateKey: data.storePrivateKey,
        workspace: {
          connect: {
            id: workspaceId
          }
        },
        lastUpdatedBy: {
          connect: {
            id: userId
          }
        }
      }
    })

    const addProjectToAdminRoleOfItsWorkspace =
      this.prisma.workspaceRole.update({
        where: {
          id: adminRole.id
        },
        data: {
          projects: {
            connect: {
              id: newProjectId
            }
          }
        }
      })

    const createEnvironmentOps = []

    // Create and assign the environments provided in the request, if any
    // or create a default environment
    if (dto.environments && dto.environments.length > 0) {
      let defaultEnvironmentExists = false
      for (const environment of dto.environments) {
        console.log('default env exists: ', defaultEnvironmentExists)
        console.log(
          'will create default env: ',
          defaultEnvironmentExists === false ? environment.isDefault : false
        )
        createEnvironmentOps.push(
          this.prisma.environment.create({
            data: {
              name: environment.name,
              description: environment.description,
              isDefault:
                defaultEnvironmentExists === false
                  ? environment.isDefault
                  : false,
              projectId: newProjectId,
              lastUpdatedById: user.id
            }
          })
        )

        defaultEnvironmentExists =
          defaultEnvironmentExists || environment.isDefault
      }
    } else {
      createEnvironmentOps.push(
        this.prisma.environment.create({
          data: {
            name: 'Default',
            description: 'Default environment for the project',
            isDefault: true,
            projectId: newProjectId,
            lastUpdatedById: user.id
          }
        })
      )
    }

    const [newProject] = await this.prisma.$transaction([
      createNewProject,
      addProjectToAdminRoleOfItsWorkspace,
      ...createEnvironmentOps
    ])

    this.log.debug(`Created project ${newProject}`)
    // It is important that we log before the private key is set
    // in order to not log the private key
    newProject.privateKey = privateKey

    return newProject
  }

  async updateProject(
    user: User,
    projectId: Project['id'],
    dto: UpdateProject
  ): Promise<Project> {
    const project = await getProjectWithAuthority(
      user.id,
      projectId,
      Authority.UPDATE_PROJECT,
      this.prisma
    )

    // Check if project with this name already exists for the user
    if (
      (dto.name && (await this.projectExists(dto.name, user.id))) ||
      project.name === dto.name
    )
      throw new ConflictException(
        `Project with this name **${dto.name}** already exists`
      )

    const data: Partial<Project> = {
      name: dto.name,
      description: dto.description,
      storePrivateKey: dto.storePrivateKey,
      privateKey: dto.storePrivateKey ? project.privateKey : null
    }

    const versionUpdateOps = []

    let privateKey = undefined,
      publicKey = undefined
    // A new key pair can be generated only if:
    // - The existing private key is provided
    // - Or, the private key was stored
    // Only administrators can do this action since it's irreversible!
    if (dto.regenerateKeyPair && (dto.privateKey || project.privateKey)) {
      const res = createKeyPair()
      privateKey = res.privateKey
      publicKey = res.publicKey

      data.publicKey = publicKey
      // Check if the private key should be stored
      data.privateKey = dto.storePrivateKey ? privateKey : null

      // Re-hash all secrets
      for (const secret of project.secrets) {
        const versions = await this.prisma.secretVersion.findMany({
          where: {
            secretId: secret.id
          }
        })

        const updatedVersions: Partial<SecretVersion>[] = []

        for (const version of versions) {
          updatedVersions.push({
            id: version.id,
            value: encrypt(
              decrypt(project.privateKey, version.value),
              privateKey
            )
          })
        }

        for (const version of updatedVersions) {
          versionUpdateOps.push(
            this.prisma.secretVersion.update({
              where: {
                id: version.id
              },
              data: {
                value: version.value
              }
            })
          )
        }
      }
    }

    // Update and return the project
    const updateProjectOp = this.prisma.project.update({
      where: {
        id: projectId
      },
      data: {
        ...data,
        lastUpdatedById: user.id
      }
    })

    const [updatedProject] = await this.prisma.$transaction([
      updateProjectOp,
      ...versionUpdateOps
    ])

    this.log.debug(`Updated project ${updatedProject.id}`)
    return {
      ...updatedProject,
      privateKey
    }
  }

  async deleteProject(user: User, projectId: Project['id']): Promise<void> {
    const project = await getProjectWithAuthority(
      user.id,
      projectId,
      Authority.DELETE_PROJECT,
      this.prisma
    )

    // Delete the project
    await this.prisma.project.delete({
      where: {
        id: projectId
      }
    })

    this.log.debug(`Deleted project ${project}`)
  }

  async getProjectByUserAndId(user: User, projectId: Project['id']) {
    const project = await getProjectWithAuthority(
      user.id,
      projectId,
      Authority.READ_PROJECT,
      this.prisma
    )

    return project
  }

  async getProjectById(projectId: Project['id']) {
    const project = await getProjectWithAuthority(
      null,
      projectId,
      Authority.READ_PROJECT,
      this.prisma
    )

    return project
  }

  async getProjectsOfWorkspace(
    user: User,
    workspaceId: Workspace['id'],
    page: number,
    limit: number,
    sort: string,
    order: string,
    search: string
  ) {
    return (
      await this.prisma.project.findMany({
        skip: (page - 1) * limit,
        take: limit,
        orderBy: {
          [sort]: order
        },
        where: {
          workspaceId,
          OR: [
            {
              name: {
                contains: search
              }
            },
            {
              description: {
                contains: search
              }
            }
          ],
          workspace: {
            members: {
              some: {
                userId: user.id
              }
            }
          }
        }
      })
    ).map((project) => excludeFields(project, 'privateKey', 'publicKey'))
  }

  async getProjects(
    page: number,
    limit: number,
    sort: string,
    order: string,
    search: string
  ) {
    return (
      await this.prisma.project.findMany({
        skip: (page - 1) * limit,
        take: limit,
        orderBy: {
          [sort]: order
        },
        where: {
          OR: [
            {
              name: {
                contains: search
              }
            },
            {
              description: {
                contains: search
              }
            }
          ]
        }
      })
    ).map((project) => excludeFields(project, 'privateKey', 'publicKey'))
  }

  private async projectExists(
    projectName: string,
    workspaceId: Workspace['id']
  ): Promise<boolean> {
    return (
      (await this.prisma.workspaceMember.count({
        where: {
          workspaceId,
          workspace: {
            projects: {
              some: {
                name: projectName
              }
            }
          }
        }
      })) > 0
    )
  }
}
