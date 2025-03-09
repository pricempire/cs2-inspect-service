import { Module } from '@nestjs/common'
import { InspectService } from './inspect.service'
import { InspectController } from './inspect.controller'
import { ParseService } from './parse.service'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Asset } from 'src/entities/asset.entity'
import { History } from 'src/entities/history.entity'
import { FormatService } from './format.service'
import { PricempireModule } from '../pricempire/pricempire.module'
import { HttpModule } from '@nestjs/axios'
import { Rankings } from 'src/views/rankings.view'
import { QueueService } from './queue.service'
import { WorkerManagerService } from './worker/worker-manager.service'

@Module({
    imports: [
        TypeOrmModule.forFeature([Asset, History, Rankings]),
        PricempireModule,
        HttpModule,
    ],
    providers: [InspectService, ParseService, FormatService, QueueService, WorkerManagerService],
    controllers: [InspectController],
})
export class InspectModule { }
