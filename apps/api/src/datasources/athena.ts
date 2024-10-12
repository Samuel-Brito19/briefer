import aws from 'aws-sdk'
import prisma, { AthenaDataSource, decrypt } from '@briefer/database'
import { config } from '../config/index.js'
import { logger } from '../logger.js'
import {
  DataSourceColumn,
  DataSourceConnectionError,
  DataSourceSchema,
  DataSourceStructure,
  DataSourceTable,
} from '@briefer/types'
import { DataSourceStatus } from './index.js'

async function getAthenaClient(
  ds: AthenaDataSource
): Promise<{ athena: aws.Athena; glue: aws.Glue; s3OutputPath: string }> {
  const athenaDs = await prisma().athenaDataSource.findUniqueOrThrow({
    where: { id: ds.id },
  })
  const athena = new aws.Athena({
    region: athenaDs.region,
    accessKeyId: decrypt(
      athenaDs.accessKeyId,
      config().DATASOURCES_ENCRYPTION_KEY
    ),
    secretAccessKey: decrypt(
      athenaDs.secretAccessKeyId,
      config().DATASOURCES_ENCRYPTION_KEY
    ),
  })
  const glue = new aws.Glue({
    region: athenaDs.region,
    accessKeyId: decrypt(
      athenaDs.accessKeyId,
      config().DATASOURCES_ENCRYPTION_KEY
    ),
    secretAccessKey: decrypt(
      athenaDs.secretAccessKeyId,
      config().DATASOURCES_ENCRYPTION_KEY
    ),
  })

  return {
    athena,
    glue,
    s3OutputPath: athenaDs.s3OutputPath,
  }
}

export async function ping(ds: AthenaDataSource): Promise<AthenaDataSource> {
  const { athena: client, s3OutputPath } = await getAthenaClient(ds)

  const params = {
    QueryString: 'SELECT 1',
    ResultConfiguration: {
      OutputLocation: s3OutputPath,
    },
  }

  let err: DataSourceConnectionError | null = null

  try {
    const r = await client.startQueryExecution(params).promise()
    if (r.QueryExecutionId) {
      // 10 seconds
      const maxTime = Date.now() + 10000
      while (true) {
        const query = await client
          .getQueryExecution({ QueryExecutionId: r.QueryExecutionId })
          .promise()
        if (query.QueryExecution?.Status?.State === 'SUCCEEDED') {
          break
        }
        if (query.QueryExecution?.Status?.State === 'FAILED') {
          if (query.QueryExecution?.Status?.AthenaError) {
            err = {
              name: `AthenaError ${query.QueryExecution.Status.AthenaError.ErrorType}`,
              message:
                query.QueryExecution.Status.AthenaError.ErrorMessage ??
                'Query execution failed',
            }
            break
          }

          err = {
            name: 'AWSResponseError',
            message: `Query(${r.QueryExecutionId}) failed with unknown error`,
          }
          break
        }

        const now = Date.now()
        if (now > maxTime) {
          err = {
            name: 'TimeoutError',
            message: 'Did not receive a response from Athena within 10s',
          }
          break
        }
        await new Promise((r) => setTimeout(r, 200))
      }
    } else {
      err = {
        name: 'AWSResponseError',
        message: 'QueryExecutionId not found',
      }
    }
  } catch (e) {
    const parsedErr = DataSourceConnectionError.safeParse(e)
    if (parsedErr.success) {
      err = parsedErr.data
    } else {
      logger().error(
        {
          dataSourceId: ds.id,
          workspaceId: ds.workspaceId,
          error: e,
        },
        'Failed to parse error from Athena ping'
      )
      err = {
        name: 'UnknownError',
        message: 'Unknown error',
      }
    }
  }

  if (err) {
    return updateConnStatus(ds, { connStatus: 'offline', connError: err })
  }

  const now = new Date()
  return updateConnStatus(ds, {
    connStatus: 'online',
    lastConnection: now,
  })
}

export async function getAthenaSchema(
  ds: AthenaDataSource
): Promise<DataSourceStructure> {
  const { glue } = await getAthenaClient(ds)
  const databases = await glue.getDatabases().promise()
  const schemas: Record<string, DataSourceSchema> = {}

  await Promise.all(
    databases.DatabaseList.map(async (database) => {
      const databaseName = database.Name
      const tablesResponse = await glue
        .getTables({ DatabaseName: databaseName })
        .promise()
      const tables: Record<string, DataSourceTable> = {}

      for (const table of tablesResponse.TableList ?? []) {
        // Retrieve regular columns
        const columns: DataSourceColumn[] = (
          table.StorageDescriptor?.Columns ?? []
        ).map((column) => ({
          name: column.Name,
          type: column.Type ?? 'unknown',
        }))

        // Retrieve partition columns (partition keys)
        const partitionColumns: DataSourceColumn[] = (
          table.PartitionKeys ?? []
        ).map((partitionKey) => ({
          name: partitionKey.Name,
          type: partitionKey.Type ?? 'unknown',
        }))

        // Merge regular columns and partition columns
        tables[table.Name] = { columns: [...columns, ...partitionColumns] }
      }

      schemas[databaseName] = { tables }
    })
  )

  return {
    dataSourceId: ds.id,
    schemas,
    defaultSchema: 'default',
  }
}

export async function updateConnStatus(
  ds: AthenaDataSource,
  status: DataSourceStatus
): Promise<AthenaDataSource> {
  const newDs = await prisma().athenaDataSource.update({
    where: { id: ds.id },
    data: {
      connStatus: status.connStatus,
      lastConnection:
        status.connStatus === 'online' ? status.lastConnection : undefined,
      connError:
        status.connStatus === 'offline'
          ? JSON.stringify(status.connError)
          : undefined,
    },
  })

  return {
    ...ds,
    connStatus: newDs.connStatus,
    lastConnection: newDs.lastConnection?.toISOString() ?? null,
    connError: newDs.connError ? JSON.parse(newDs.connError) : null,
  }
}
