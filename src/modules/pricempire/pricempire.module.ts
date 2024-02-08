import { Module } from '@nestjs/common'
import { HttpModule } from '@nestjs/axios'
import { PricempireService } from './pricempire.service'

@Module({
    imports: [HttpModule],
    providers: [PricempireService],
    exports: [PricempireService],
})
export class PricempireModule {}
