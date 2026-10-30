<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<S124:Dataset xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:S124="http://www.iho.int/S124/gml/2.0" xmlns:S100="http://www.iho.int/s100gml/5.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xlink="http://www.w3.org/1999/xlink" gml:id="CCG.S124.CA01.C.3941.26" xsi:schemaLocation="http://www.iho.int/S124/gml/2.0 https://schemas.s100dev.net/schemas/S124/2.0.0/20250728/124_2.0.0.xsd">
    <gml:boundedBy>
        <gml:Envelope srsName="https://www.opengis.net/def/crs/EPSG/0/4326" srsDimension="2">
            <gml:lowerCorner>43.853253 -78.715497</gml:lowerCorner>
            <gml:upperCorner>43.869920 -78.698830</gml:upperCorner>
        </gml:Envelope>
    </gml:boundedBy>
    <S100:DatasetIdentificationInformation>
        <S100:encodingSpecification>S-100 Part 10b</S100:encodingSpecification>
        <S100:encodingSpecificationEdition>1.0</S100:encodingSpecificationEdition>
        <S100:productIdentifier>S-124</S100:productIdentifier>
        <S100:productEdition>2.0.0</S100:productEdition>
        <S100:applicationProfile>1</S100:applicationProfile>
        <S100:datasetFileIdentifier>124CA01C_3941_26.GML</S100:datasetFileIdentifier>
        <S100:datasetTitle>Marine works</S100:datasetTitle>
        <S100:datasetReferenceDate>2026-09-11</S100:datasetReferenceDate>
        <S100:datasetLanguage>eng</S100:datasetLanguage>
        <S100:datasetAbstract>The abstract of the dataset</S100:datasetAbstract>
        <S100:datasetTopicCategory>oceans</S100:datasetTopicCategory>
        <S100:datasetPurpose>base</S100:datasetPurpose>
        <S100:updateNumber>0</S100:updateNumber>
    </S100:DatasetIdentificationInformation>
    <S124:members>
        <S124:NavwarnPreamble gml:id="CCG.S124.CA01.C.3941.26.0">
            <S124:affectedChartPublications>
                <S124:chartAffected>
                    <S124:chartNumber>2058</S124:chartNumber>
                    <S124:editionDate>2025-04-11</S124:editionDate>
                </S124:chartAffected>
                <S124:language>eng</S124:language>
                <S124:publicationAffected>Cobourg to/à Oshawa</S124:publicationAffected>
            </S124:affectedChartPublications>
            <S124:generalArea>
                <S124:locationName>
                    <S124:language>eng</S124:language>
                    <S124:text>Lake Ontario</S124:text>
                </S124:locationName>
            </S124:generalArea>
            <S124:locality>
                <S124:locationName>
                    <S124:language>eng</S124:language>
                    <S124:text>Bowmanville</S124:text>
                </S124:locationName>
            </S124:locality>
            <S124:messageSeriesIdentifier>
                <S124:agencyResponsibleForProduction>Canadian Coast Guard</S124:agencyResponsibleForProduction>
                <S124:interoperabilityIdentifier>urn:mrn:CCG.S124.CA01.C.3941.26</S124:interoperabilityIdentifier>
                <S124:nameOfSeries>C</S124:nameOfSeries>
                <S124:nationality>Canada</S124:nationality>
                <S124:warningNumber>3941</S124:warningNumber>
                <S124:warningType code="1">Local Navigational Warning</S124:warningType>
                <S124:year>2026</S124:year>
            </S124:messageSeriesIdentifier>
            <S124:navwarnTitle>
                <S124:language>eng</S124:language>
                <S124:text>Marine works</S124:text>
            </S124:navwarnTitle>
            <S124:intService>true</S124:intService>
            <S124:navwarnTypeGeneral code="19">Works</S124:navwarnTypeGeneral>
            <S124:publicationTime>2026-09-11T14:44:37.84</S124:publicationTime>
            <S124:theReferences xlink:href="#CCG.S124.CA01.C.3941.26.1"/>
            <S124:theReferences xlink:href="#CCG.S124.CA01.C.3941.26.2"/>
        </S124:NavwarnPreamble>
        <S124:References gml:id="CCG.S124.CA01.C.3941.26.1">
            <S124:messageSeriesIdentifier>
                <S124:agencyResponsibleForProduction>Canadian Coast Guard</S124:agencyResponsibleForProduction>
                <S124:interoperabilityIdentifier>urn:mrn:CCG.S124.CA01.C.1220.26</S124:interoperabilityIdentifier>
                <S124:nameOfSeries>C</S124:nameOfSeries>
                <S124:nationality>Canada</S124:nationality>
                <S124:warningNumber>2026</S124:warningNumber>
                <S124:warningType code="1">Local Navigational Warning</S124:warningType>
                <S124:year>2026</S124:year>
            </S124:messageSeriesIdentifier>
            <S124:noMessageOnHand>false</S124:noMessageOnHand>
            <S124:referenceCategory code="1">Warning Cancellation</S124:referenceCategory>
            <S124:theWarning xlink:href="#CCG.S124.CA01.C.1220.26"/>
        </S124:References>
        <S124:NavwarnPart gml:id="CCG.S124.CA01.C.3941.26.2">
            <S124:fixedDateRange>
                <S124:dateStart>
                    <S100:date>2026-09-11</S100:date>
                </S124:dateStart>
            </S124:fixedDateRange>
            <S124:warningInformation>
                <S124:information>
                    <S124:language>eng</S124:language>
                    <S124:text>Construction and diving operations taking place 24 hours a day southeast of the Darlington Nuclear Generating Station within a 500 metre radius centered on 43 51.695N 078 42.430W. Tugs and barges on site. 
Minimum wake requested and stay clear 800 metres.</S124:text>
                </S124:information>
                <S124:navwarnTypeDetails code="87">Diving Operation</S124:navwarnTypeDetails>
            </S124:warningInformation>
            <S124:header xlink:href="#CCG.S124.CA01.C.3941.26.0"/>
            <S124:geometry>
                <S100:surfaceProperty>
                    <S100:Surface gml:id="CCG.S124.CA01.C.3941.26.location.1" srsName="https://www.opengis.net/def/crs/EPSG/0/4326" srsDimension="2">
                        <gml:patches>
                            <gml:PolygonPatch interpolation="planar">
<gml:exterior>
    <gml:Ring>
        <gml:curveMember>
            <S100:Curve gml:id="CCG.S124.CA01.C.3941.26.location.1.0" srsName="https://www.opengis.net/def/crs/EPSG/0/4326" srsDimension="2">
                <gml:segments>
                    <S100:S100_CircleByCenterPoint>
                        <gml:pos srsName="https://www.opengis.net/def/crs/EPSG/0/4326" srsDimension="2">43.861586 -78.707163</gml:pos>
                        <S100:radius uom="NM">0.27</S100:radius>
                        <S100:startAngle>0.0</S100:startAngle>
                        <S100:angularDistance>360.0</S100:angularDistance>
                    </S100:S100_CircleByCenterPoint>
                </gml:segments>
            </S100:Curve>
        </gml:curveMember>
    </gml:Ring>
</gml:exterior>
                            </gml:PolygonPatch>
                        </gml:patches>
                    </S100:Surface>
                </S100:surfaceProperty>
            </S124:geometry>
        </S124:NavwarnPart>
    </S124:members>
</S124:Dataset>
